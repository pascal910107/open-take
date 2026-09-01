// The machine-readable defect report — what a defective verdict prints so the
// agent driving the CLI can relay the gate's findings VERBATIM to whoever
// authored the plan, instead of re-narrating them (every re-narration is a
// chance to drop the one measured number that made the fix mechanical).
//
// The block is the repair loop's wire format: a fixed stdout section between
// DEFECTS_OPEN and DEFECTS_CLOSE holding one JSON object, also written to
// `<take>.take/defects.json` on post-capture verdicts. Two properties are
// load-bearing and must stay stable:
//
//  1. EVERY finding rides along, warns included. Late-bound target poison
//     only warns (the gate cannot be certain), so a report that carried only
//     the refusals would leave the one defect class the gate can't refuse
//     invisible to the repair round — measured on a real repair run: the
//     second round closed a late-bound look poison precisely because the
//     report named the warn.
//  2. Each entry keeps the gate's own message and fix untouched: the copy is
//     teaching copy with the measured values already interpolated (benchmark:
//     teaching messages doubled one-retry repair convergence over terse ones).
//
// The engine never calls a model. This module only formats the verdict; the
// loop around it — feed the block back, re-run the verb, at most two rounds —
// is driven by the agent reading SKILL.md.

/** Every gate reports the same shape: PlanIssue (lint-plan), PrecheckIssue
 *  (precheck), CompositionIssue (validate / check-take / cursor audit) are
 *  structurally identical, so one report type carries them all. */
export type GateIssue = {
  severity: "error" | "warn";
  path: string;
  message: string;
  fix?: string;
};

/** which gate measured the finding */
export type DefectGate = "plan-lint" | "precheck" | "capture" | "post-shoot" | "composition";

export type Defect = GateIssue & { gate: DefectGate };

export type DefectReport = {
  format: "open-take-defects/1";
  verb: "make" | "render" | "check";
  /** the human verdict line, verbatim */
  verdict: string;
  /** what the process exits with after printing this block */
  exitCode: number;
  /** the plan that was judged (make only — render/check judge a take) */
  plan?: string;
  /** the delivered master, when one exists */
  master?: string;
  errors: number;
  warns: number;
  defects: Defect[];
  note: string;
  repair: string;
};

export const DEFECTS_OPEN = "--- open-take defects v1 ---";
export const DEFECTS_CLOSE = "--- end open-take defects ---";

const NOTE =
  "Deterministic gate findings, measured against the live app and the recorded take — " +
  "facts, not opinions. error = the gate refuses this take; warn = suspect — fix it or " +
  "state why it stays.";

const REPAIR =
  "Relay this block VERBATIM to the author of the plan and ask for the ENTIRE corrected " +
  "plan (same JSON shape): fix exactly what the defects name and keep every other " +
  "editorial decision unchanged. Then re-run the same command. At most two repair " +
  "rounds — a take still defective after two needs a human, not a third round.";

export const asDefects = (gate: DefectGate, issues: readonly GateIssue[]): Defect[] =>
  issues.map((i) => ({
    gate,
    severity: i.severity,
    path: i.path,
    message: i.message,
    ...(i.fix ? { fix: i.fix } : {}),
  }));

/** capture-time skipped steps as defects — error-severity: the beat is gone
 *  from the video, which is exactly what the strict exit refuses. The fix
 *  copy follows the reason: a focus skip means the target RESOLVED and the
 *  not-found copy ("point the target at an element that exists") would send
 *  the repair round at the wrong dimension. */
export const skippedDefects = (
  skipped: readonly { step: number; action: string; target?: string; reason: string }[],
): Defect[] =>
  skipped.map((s) => ({
    gate: "capture",
    severity: "error",
    path: `steps[${s.step}]`,
    message: `${s.action} ${JSON.stringify(s.target ?? "")}: step SKIPPED at capture (${s.reason}) — the video is missing this beat`,
    fix: s.reason.startsWith("focus never reached")
      ? "the target resolved but never took focus — have an earlier step click/open the control that arms this field, retarget the step at the element that actually receives the text, or drop the step; then re-make"
      : "point the target at an element that exists when this step runs (a pre-capture warning above may name the impostor or the late binding), or drop the step; then re-make",
  }));

/** Settle underruns whose beat DID go quiet carry a measured number the
 *  author can copy — the one defect class where the fix is literally a
 *  value. Beats that never settled (`reason: "budget"`) are excluded: telling
 *  an author to raise settleMs toward a number that satisfies nothing is a
 *  ratchet, and the human summary already explains that case. */
export const settleDefects = (
  settleWaits: readonly {
    step: number;
    action: string;
    heldMs: number;
    waitedMs: number;
    reason: "idle" | "budget" | "unavailable";
  }[],
): Defect[] =>
  settleWaits
    .filter((w) => w.reason === "idle")
    .map((w) => ({
      gate: "capture",
      severity: "warn",
      path: `steps[${w.step}].settleMs`,
      message: `${w.action}: held ${w.heldMs}ms but the page needed ~${w.heldMs + w.waitedMs}ms to go quiet — the capture waited, the plan under-budgeted`,
      fix: `set this step's settleMs to ${w.heldMs + w.waitedMs}`,
    }));

export function buildDefectReport(opts: {
  verb: DefectReport["verb"];
  verdict: string;
  exitCode: number;
  plan?: string;
  master?: string;
  defects: Defect[];
}): DefectReport {
  return {
    format: "open-take-defects/1",
    verb: opts.verb,
    verdict: opts.verdict,
    exitCode: opts.exitCode,
    ...(opts.plan ? { plan: opts.plan } : {}),
    ...(opts.master ? { master: opts.master } : {}),
    errors: opts.defects.filter((d) => d.severity === "error").length,
    warns: opts.defects.filter((d) => d.severity === "warn").length,
    defects: opts.defects,
    note: NOTE,
    repair: REPAIR,
  };
}

/** the fixed stdout section — everything between the sentinels is one JSON
 *  object, so the driving agent extracts it with two line matches and no
 *  scraping of the prose above it */
export const renderDefectBlock = (report: DefectReport): string =>
  `\n${DEFECTS_OPEN}\n${JSON.stringify(report, null, 1)}\n${DEFECTS_CLOSE}\n`;
