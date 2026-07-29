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

import { buildLegs, buildStageKeyframes, cameraRampSchedule, restStageScale } from "./math";
import { CLAMP_TOL_MS, MOTION, motionName } from "./presets";
import { DEFAULT_CURSOR } from "./types";
import type { CaptureLog, TakeComposition } from "./types";

/** Tail past the last beat's settle that still reads as "the shot breathing".
 *  Beyond it the delivered mp4 is a frozen screen — the padded-to-25s failure. */
const DEAD_TAIL_MS = 2500;
/** A dwell-delayed pull-out lands a little after its own action BY DESIGN, and
 *  a tail of a few frames is invisible (the spring has all but arrived). The
 *  artifact is a camera that has barely LEFT when the action fires — so gate on
 *  both an absolute floor and the fraction of the ramp still to run. */
const MOVING_AT_ACTION_MS = 150;
const MOVING_AT_ACTION_FRAC = 0.25;
/** How far past the SLOWEST shipped pace a camera window may run before it is
 *  worth a word. Anchored on the preset vocabulary rather than a number
 *  invented here, so the ceiling tracks the presets if they are ever retuned. */
const RAMP_SLACK = 2;
/** A travel clamp binding on the odd short hop is the point of having clamps;
 *  binding on more than this share of the legs means the speed law (and the
 *  whole `pace` preset) is not what paces the take. Under CLAMPED_LEGS_MIN legs
 *  the share says nothing — two clamped legs out of two is a fixture, not a
 *  finding. */
const CLAMPED_LEGS_FRAC = 0.5;
const CLAMPED_LEGS_MIN = 3;
/** A travel squeezed under this share of what the speed law asked for reads as
 *  a dart rather than a glide. Paired with an absolute floor so a few-frame
 *  shortfall on an already-short hop stays quiet. */
const SQUEEZE_FRAC = 0.7;
const SQUEEZE_MIN_MS = 200;

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
  dropFiles: "to",
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
    if (e.kind === "dropFiles" && !e.files?.length)
      warn(
        `${p}.files`,
        `dropFiles beat has no files metadata — the ghost card will show a generic "file"`,
        "restore files [{name,size}] from the capture",
      );
    if (e.kind === "dropFiles" && !dur)
      warn(
        `${p}.durationMs`,
        "dropFiles beat has no carry duration — the cursor teleports to the drop point and the ghost card only flashes",
        "restore durationMs from the capture",
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
    // inAtMs must precede the action (the zoom-in ramps in before the beat
    // lands) — EXCEPT a press: its reveal exists only after the keypress, so
    // its zoom departs AT the action (inAtMs === tMs; the schedule then runs
    // the ramp after the departure instead of landing at tMs).
    if (z.inAtMs < 0) err(`${p}.zoom.inAtMs`, `negative inAtMs ${z.inAtMs}`, "clamp to 0");
    if (z.inAtMs > e.tMs && e.kind !== "press")
      err(
        `${p}.zoom.inAtMs`,
        `inAtMs ${z.inAtMs} is AFTER the action at tMs ${e.tMs} — the zoom would arrive late`,
        `set inAtMs = tMs − cursor.zoomInMs (= ${Math.max(0, e.tMs - comp.cursor.zoomInMs)})`,
      );
    if (e.kind === "press" && z.enabled && z.inAtMs < e.tMs)
      warn(
        `${p}.zoom.inAtMs`,
        `press zoom departs ${e.tMs - z.inAtMs}ms BEFORE the keypress — its reveal doesn't exist yet, so the camera punches into empty space`,
        `set inAtMs = tMs (${e.tMs}) so the zoom rides the reveal in`,
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
      else if (z.scale < rest * 1.2)
        // the whole dead band, not just ≈rest exactly: a 1.03× "zoom" renders
        // an enabled move the eye can't see (issue #1 — it shipped silently).
        warn(
          `${p}.zoom.scale`,
          `scale ${z.scale.toFixed(3)} is within 20% of rest ${rest.toFixed(3)} — an imperceptible zoom (enabled but invisible)`,
          "raise scale to ≥ ~1.25 to actually zoom, or set enabled=false",
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

  // --- cursor motion knobs ---------------------------------------------------
  // These are plain numbers in the schema and, until here, NOTHING bounded them:
  // a hand edit (or an agent reaching for "start the zoom earlier" and stretching
  // the wrong knob) could put the whole take on a crawl with every other check
  // still passing.
  //
  // PRESENT-but-nonsensical is an error: the schedule arithmetic turns it into
  // NaN keyframes. ABSENT is usually the LEGACY shape — compositions predate
  // travelWidthsPerSec / travelMin/MaxMs / zoomInMs and the schedule has a
  // documented fallback for each — so absence is an error only where nothing
  // can stand in. (A validator that refused to render yesterday's composition
  // would be a worse bug than the one it catches.)
  const cur = comp.cursor;
  type MsKnob =
    | "travelMs"
    | "travelMinMs"
    | "travelMaxMs"
    | "holdMs"
    | "zoomInMs"
    | "zoomOutMs"
    | "travelWidthsPerSec";
  const knob = (k: MsKnob, positive: boolean, required: boolean) => {
    const v: number | undefined = cur[k];
    if (v == null) {
      if (required)
        err(
          `cursor.${k}`,
          `${k} is missing and the schedule has no fallback for it`,
          `set cursor.${k} to the shipped default (${DEFAULT_CURSOR[k]})`,
        );
      return;
    }
    if (typeof v !== "number" || !Number.isFinite(v) || (positive ? v <= 0 : v < 0))
      err(
        `cursor.${k}`,
        `${k} must be a ${positive ? "positive" : "non-negative"} number (got ${JSON.stringify(v)})`,
        `restore the shipped default (${DEFAULT_CURSOR[k]})`,
      );
  };
  // The speed law is live only with a positive travelWidthsPerSec; without it
  // the cursor runs on the fixed travelMs and the clamps are never consulted.
  const speedLaw = typeof cur.travelWidthsPerSec === "number" && cur.travelWidthsPerSec > 0;
  knob("holdMs", false, true);
  knob("zoomOutMs", true, true);
  knob("zoomInMs", true, false); // absent ⇒ the legacy inAtMs→tMs window
  knob("travelWidthsPerSec", false, false); // absent/0 ⇒ the documented travelMs fallback
  knob("travelMs", true, !speedLaw);
  knob("travelMinMs", false, speedLaw);
  knob("travelMaxMs", true, speedLaw);
  if (
    Number.isFinite(cur.travelMinMs) &&
    Number.isFinite(cur.travelMaxMs) &&
    cur.travelMaxMs < cur.travelMinMs
  )
    // An inverted band has no coherent answer, and the clamps are applied in
    // order (floor first — see math.ts travelDur), so every leg lands on one
    // bound or the other and the ordering INVERTS: a short hop takes the
    // 800ms floor while a full-frame sweep takes the 400ms ceiling.
    err(
      "cursor.travelMaxMs",
      `travelMaxMs ${cur.travelMaxMs} is below travelMinMs ${cur.travelMinMs} — an inverted band, so every leg is pinned to one bound or the other and SHORT hops (${cur.travelMinMs}ms) end up slower than full-frame sweeps (${cur.travelMaxMs}ms)`,
      `raise travelMaxMs above travelMinMs (defaults ${DEFAULT_CURSOR.travelMinMs}/${DEFAULT_CURSOR.travelMaxMs})`,
    );
  // A punch-in's ramp END is pinned to the action instant, so a LONGER window
  // means departing EARLIER and creeping — never landing later. Past roughly
  // twice the slowest shipped pace the settle curve reads as a drift, and
  // nothing else here catches it (the crowded-release check below only fires on
  // a ramp that lands LATE).
  if (cur.zoomInMs > MOTION.calm.zoomInMs * RAMP_SLACK)
    warn(
      "cursor.zoomInMs",
      `zoomInMs ${cur.zoomInMs} is over ${RAMP_SLACK}× the slowest shipped pace (calm = ${MOTION.calm.zoomInMs}) — a punch-in lands ON the action, so this departs that much earlier and creeps in`,
      `${DEFAULT_CURSOR.zoomInMs} is the frame-measured default; use pace "calm" (${MOTION.calm.zoomInMs}) for a gentler punch`,
    );
  if (cur.zoomOutMs > MOTION.calm.zoomOutMs * RAMP_SLACK)
    warn(
      "cursor.zoomOutMs",
      `zoomOutMs ${cur.zoomOutMs} is over ${RAMP_SLACK}× the slowest shipped pace (calm = ${MOTION.calm.zoomOutMs}) — every release drifts out for that long, and the tail must outlast it`,
      `${DEFAULT_CURSOR.zoomOutMs} is the frame-measured default; use pace "calm" (${MOTION.calm.zoomOutMs}) for a slower release`,
    );

  // camera-rect spring: bounce shapes the ONE ease driving centre+size, so an
  // out-of-range value corrupts every camera move (see math.ts springEase).
  const spring = comp.cursor.zoomSpring;
  if (spring != null) {
    if (!(spring >= 0 && spring < 0.6))
      err(
        "cursor.zoomSpring",
        `zoomSpring ${spring} outside [0, 0.6)`,
        "0 = critically damped (the default feel); keep bounce ≤ 0.3",
      );
    else if (spring > 0.3)
      warn(
        "cursor.zoomSpring",
        `zoomSpring ${spring} is a lot of bounce — the rect overshoot can flash backdrop at edge-flush targets and over-zoom tight punches`,
        "keep ≤ 0.3 (the editor slider's max) unless the flash is wanted",
      );
  }

  // asymptotic settle: the residual left to creep out after the action instant.
  // Beyond ~0.15 the camera visibly hasn't arrived when the action fires.
  const settleFrac = comp.cursor.zoomSettleFrac;
  if (settleFrac != null && !(settleFrac >= 0 && settleFrac <= 0.15))
    err(
      "cursor.zoomSettleFrac",
      `zoomSettleFrac ${settleFrac} outside [0, 0.15]`,
      "~0.04 = the reference-measured tail; 0 = legacy cut spring",
    );
  else if (settleFrac != null && settleFrac > 0 && (comp.cursor.zoomEase || spring != null))
    warn(
      "cursor.zoomSettleFrac",
      `zoomSettleFrac is IGNORED while cursor.${comp.cursor.zoomEase ? "zoomEase" : "zoomSpring"} is set — the render is byte-identical to not setting it`,
      "delete cursor.zoomEase / cursor.zoomSpring (a pace preset clears zoomEase) to activate the settle tail",
    );

  const dwell = comp.cursor.pullOutDwellMs;
  if (dwell != null && !(dwell >= 0 && dwell <= 5000))
    err(
      "cursor.pullOutDwellMs",
      `pullOutDwellMs ${dwell} outside [0, 5000]`,
      "600-1000 reads as a natural beat; 0 = legacy (depart as soon as the action ends)",
    );

  // SILENT PACE OVERRIDE: travelMinMs/travelMaxMs are applied AFTER the speed
  // law (math.ts buildLegs), so on the legs they bind it is the clamp — not
  // travelWidthsPerSec — that sets the duration. travelWidthsPerSec is what a
  // `pace` preset moves and travelMin/MaxMs are NOT in the preset, so a take
  // whose legs are mostly clamped answers a pace change with a shrug. Nothing
  // in the JSON shows this; only the legs do.
  if (cur.travelWidthsPerSec > 0 && issues.every((i) => i.severity !== "error")) {
    try {
      const travels = buildLegs(comp).filter((l) => !l.drag);
      const pace = motionName(cur);
      // RUSHED TRAVEL: a leg is bounded on the left by the previous beat's
      // action end, so a beat that runs late (or a settleMs too short to hold
      // the glide that follows it) squeezes the move into whatever is left and
      // the cursor darts. This is the cursor's twin of the crowded-release
      // check below, and like it the fix is in the RECORDING: nothing in the
      // composition can widen a gap the capture never left.
      const shortfall = (l: (typeof travels)[number]) => (l.wantSec ?? 0) - (l.t1 - l.t0);
      const squeezed = travels
        .filter(
          (l) =>
            l.wantSec != null &&
            l.t1 - l.t0 < l.wantSec * SQUEEZE_FRAC &&
            shortfall(l) > SQUEEZE_MIN_MS / 1000,
        )
        .sort((a, b) => shortfall(b) - shortfall(a));
      const worst = squeezed[0];
      if (worst) {
        const got = Math.round((worst.t1 - worst.t0) * 1000);
        const want = Math.round((worst.wantSec ?? 0) * 1000);
        const prev = worst.evIdx != null ? events[worst.evIdx - 1] : undefined;
        warn(
          `events[${worst.evIdx}]`,
          `${squeezed.length === 1 ? "this beat's" : `${squeezed.length} beats' travel is rushed; the worst`} approach gets ${got}ms of the ${want}ms the speed law asks for — the cursor darts in${prev ? ` because events[${worst.evIdx! - 1}] (${prev.kind}) is still running until ${prev.tMs + (prev.durationMs ?? 0)}ms` : " because the take starts too close to it"}`,
          prev
            ? `raise the previous step's settleMs by ≥ ${want - got}ms and re-\`make\` — the gap is in the CAPTURE, no cursor knob can widen it`
            : `add a leading \`wait\` (or move \`start\` closer) and re-\`make\` — the opening sweep has no room`,
        );
      }
      for (const which of ["min", "max"] as const) {
        const n = travels.filter((l) => l.clamped === which).length;
        if (travels.length < CLAMPED_LEGS_MIN || n <= travels.length * CLAMPED_LEGS_FRAC) continue;
        const field = which === "min" ? "travelMinMs" : "travelMaxMs";
        // A clamp at ITS PACE'S value is not an override — it IS the pace, it
        // was tuned with the rest of the bundle, and re-pacing moves those legs
        // like any other. Only a clamp somebody HAND-SET away from the pace
        // overrides it, and only then is there anything to say. (Before the
        // clamps joined MOTION every clamped leg really was deaf to the pace,
        // and this warning said so; saying it now would be false.)
        const shipped = pace ? MOTION[pace] : DEFAULT_CURSOR;
        // Same tolerance motionName uses, so the two can never disagree: a
        // value near enough to keep the pace's NAME is near enough to be the
        // pace, and must not be reported as overriding it.
        if (Math.abs(cur[field] - shipped[field]) < CLAMP_TOL_MS) continue;
        warn(
          `cursor.${field}`,
          `${n} of ${travels.length} travel legs are ${which === "min" ? "floored at" : "capped at"} a hand-set cursor.${field} of ${cur[field]}ms — on those the clamp sets the duration, not cursor.travelWidthsPerSec${pace ? `, so they no longer move with the "${pace}" pace (which ships ${shipped[field]}ms)` : ""}`,
          `restore cursor.${field} to ${shipped[field]}${pace ? ` (the "${pace}" pace's own value)` : " (the shipped default)"} to put those legs back under the speed law — or keep it, if they are meant to read as ${which === "min" ? "darts" : "one steady sweep"}`,
        );
      }
    } catch {
      /* never let a diagnostics pass throw */
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
  // …and the mirror image: a tail so long the delivered mp4 ends on a frozen
  // screen. The classic cause is padding a plan with trailing `wait`s to hit a
  // "~25s" target — the capture keeps rolling long after the last payoff has
  // settled and nothing on screen changes again. Cheap to fix (durationMs is
  // render-only), invisible to an agent that never watches the tail.
  else if (events.length) {
    const settledEnd = lastEnd + comp.cursor.holdMs + comp.cursor.zoomOutMs;
    if (comp.durationMs > settledEnd + DEAD_TAIL_MS)
      warn(
        "durationMs",
        `${((comp.durationMs - settledEnd) / 1000).toFixed(1)}s of tail after the last beat settles — the delivered video ends on a frozen screen`,
        `trim durationMs to ≈ ${Math.round(settledEnd)}, or add a beat that earns the time`,
      );
  }

  // CROWDED RELEASE: the camera should be PARKED at the instant an action
  // fires. A release (a zoomed beat followed by a full-view one) needs
  // pullOutDwellMs + zoomOutMs of room after the previous beat's payoff
  // settles; when the gap is tighter the schedule keeps the ramp and lands it
  // LATE — deliberately, because fleeing a frame the viewer is still reading is
  // worse — and the frame slides out from under the next click. That trade is
  // right given the recording, but the recording is the thing to fix, so say
  // so. (A zoom-enabled `press` is reveal-timed by construction: it departs AT
  // the keypress and rides the reveal in, so its late landing is the design.)
  if (issues.every((i) => i.severity !== "error")) {
    try {
      const sched = cameraRampSchedule(comp);
      const room = (comp.cursor.pullOutDwellMs ?? 0) + comp.cursor.zoomOutMs;
      for (let i = 0; i < events.length; i++) {
        const e = events[i]!;
        const r = sched[i];
        if (!r) continue;
        const rampMs = r.landMs - r.startMs;
        // OVER-LONG WINDOW: the ramp a beat actually gets is inAtMs → its
        // landing, so a hand-set inAtMs — not cursor.zoomInMs — is what makes a
        // multi-second creep. The usual cause is reading "start the zoom
        // earlier" as "start it much earlier": the landing is pinned to the
        // action, so the only thing that moves is how slowly it gets there.
        // Only HAND-SET windows are flagged; the planner's own default is
        // clamped at 0 for an early first beat and that is by design.
        const nominal = r.pullOut ? comp.cursor.zoomOutMs : comp.cursor.zoomInMs;
        const handSet = Math.abs(e.zoom.inAtMs - Math.max(0, e.tMs - comp.cursor.zoomInMs)) >= 1;
        if (handSet && nominal > 0 && rampMs > nominal * RAMP_SLACK)
          warn(
            `events[${i}].zoom.inAtMs`,
            `this beat's camera window runs ${Math.round(rampMs)}ms — ${(rampMs / nominal).toFixed(1)}× cursor.${r.pullOut ? "zoomOutMs" : "zoomInMs"} (${nominal}ms) — so the camera departs at ${Math.round(r.startMs)}ms and creeps to the action instead of moving at the take's pace`,
            `set inAtMs = ${Math.max(0, e.tMs - comp.cursor.zoomInMs)} (tMs − cursor.zoomInMs) and change cursor.${r.pullOut ? "zoomOutMs" : "zoomInMs"} if the RAMP itself should be slower`,
          );
        if (e.kind === "press") continue;
        const lateMs = Math.round(r.landMs - e.tMs);
        if (lateMs <= MOVING_AT_ACTION_MS) continue;
        if (!(rampMs > 0) || lateMs / rampMs <= MOVING_AT_ACTION_FRAC) continue;
        const prev = events[i - 1];
        const prevEnd = prev ? prev.tMs + (prev.durationMs ?? 0) : 0;
        // The dwell floor can push the departure past the action entirely, and
        // then "% of the move done" is negative — a fraction that cannot
        // describe a camera which has not left yet. Say the stronger thing.
        const doneFrac = 1 - lateMs / rampMs;
        const progress =
          doneFrac > 0
            ? `has only ${Math.round(doneFrac * 100)}% of its move done`
            : "has not even departed";
        warn(
          `events[${i}].zoom`,
          `the camera ${progress} when this beat's action fires (departs ${Math.round(r.startMs)}ms, lands ${Math.round(r.landMs)}ms, action ${e.tMs}ms) — the frame slides out from under it${prev ? `; the previous beat settles only ${Math.round(e.tMs - prevEnd)}ms earlier` : ""}`,
          prev
            ? `hold the frame — copy events[${i - 1}].zoom onto this beat so the camera never moves at the action; or re-capture with ≥ ${room}ms of settle on events[${i - 1}] (cursor.pullOutDwellMs + cursor.zoomOutMs)`
            : `re-capture with more lead-in before this beat, or set zoom.enabled=false`,
        );
      }
    } catch {
      /* never let a diagnostics pass throw */
    }
  }

  // A dwell-delayed final pull-out can land LATER than the legacy tail math
  // above assumes — check the actual schedule, not the formula. (Guarded: the
  // schedule needs a structurally sound composition; earlier errors mean this
  // check would throw, and its absence is already explained by them.)
  if ((comp.cursor.pullOutDwellMs ?? 0) > 0 && issues.every((i) => i.severity !== "error")) {
    try {
      const kfs = buildStageKeyframes(comp).r;
      let motionEndS = 0;
      for (let i = 0; i < kfs.length - 1; i++) {
        const [, a] = kfs[i]!;
        const [t1, b] = kfs[i + 1]!;
        if (a.cx !== b.cx || a.cy !== b.cy || a.w !== b.w) motionEndS = t1;
      }
      if (motionEndS * 1000 > comp.durationMs + 1)
        warn(
          "durationMs",
          `the camera is still mid-motion at durationMs (dwell-delayed landing ends ~${Math.round(motionEndS * 1000)}ms)`,
          `raise durationMs to ≥ ${Math.round(motionEndS * 1000)}`,
        );
    } catch {
      /* never let a diagnostics pass throw */
    }
  }

  // head trim: cut dead pre-paint frames, never a beat. The trim only moves
  // the delivered head — tMs values stay on the capture timeline.
  const startMs = comp.startMs;
  if (startMs != null) {
    if (!(startMs >= 0) || startMs >= comp.durationMs)
      err(
        "startMs",
        `startMs ${startMs} outside [0, durationMs ${comp.durationMs})`,
        "the head trim must leave a video",
      );
    else if (comp.events[0] && startMs > comp.events[0].zoom.inAtMs)
      warn(
        "startMs",
        `startMs ${startMs} cuts into the first beat (camera/cursor already moving at ${comp.events[0].zoom.inAtMs}ms)`,
        `keep the trim ≤ ${comp.events[0].zoom.inAtMs} so the delivered video opens at rest`,
      );
  }

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
