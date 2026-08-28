// runPostShootGates — the post-shoot gate orchestrator shared by every verb
// that judges a delivered take (`make`, `render`, `check`). The gates
// themselves live elsewhere (checkTake reads pixels + the capture log;
// auditCursor template-matches the drawn cursor against the compositor's own
// math); this module owns the behaviors the callers must agree on:
//
//  1. Failure isolation — a gate that cannot run must not discard the checks
//     that already did. Each gate is caught and reported, never thrown; the
//     result names the gates that never produced a measurement (`crashed`)
//     so a caller whose product IS the verdict (`check`) can refuse to call
//     an unjudged take clean.
//  2. The bounded re-render — a cursor-audit ERROR triggers ONE deterministic
//     re-render + a full re-run of every gate before any exit code fires.
//     Measured on a real take: the renderer can transiently misdraw the
//     cursor (the same master re-audits identically wrong, while a re-render
//     of the same composition comes back clean) — and the audit is the only
//     gate that sees it. One re-render heals the transient class; a repeat
//     failure means the renderer truly disagrees with its own math, which is
//     a bug to look at, not to retry past. Bounded at ONE for the same
//     reason plan repair is: unbounded retry turns a deterministic gate into
//     a slot machine.
//  3. A crash never LOWERS the verdict. A gate that measured an error on the
//     first pass and then crashed on the re-audit keeps its first-pass
//     findings — "we could not re-measure" must never read as "it healed".
//
// Every gate re-runs after the re-render, not just the cursor audit: the
// re-render replaces the delivered pixels, and repairs have been measured to
// re-roll defects — what was clean before a fix is not guaranteed clean
// after it.

import type { CompositionIssue } from "@open-take/compositor";

export type PostShootPass = "post-shoot" | "re-audit";

export type PostShootIO = {
  /** checkTake over the current delivered mp4 (dead opening / static tail /
   *  zoom-vs-payoff / dead beats) */
  checkTake: () => Promise<CompositionIssue[]>;
  /** auditCursor over the current delivered mp4 */
  auditCursor: () => Promise<CompositionIssue[]>;
  /** Deterministically re-render the delivered mp4 over the frozen capture,
   *  replacing it IN PLACE (render to a scratch name, rename over the master
   *  only on success — a crashed re-render must not eat the file the first
   *  audit measured; see reRenderInPlace). Absent ⇒ report-only: the `check`
   *  verb never rewrites a take, and a take already doomed by skipped steps
   *  earns no render minutes. */
  reRender?: () => Promise<void>;
  /** one pass's findings, in print order (checkTake first) — caller prints */
  onFindings: (issues: CompositionIssue[], pass: PostShootPass) => void;
  /** narration (the re-render decision and its outcome) */
  log: (line: string) => void;
  /** a gate or the re-render crashed — reported, never thrown */
  warn: (line: string) => void;
};

export type PostShootResult = {
  /** the verdict findings — the last MEASURED value per gate */
  issues: CompositionIssue[];
  /** error-severity count in `issues` */
  errors: number;
  /** the bounded re-render ran and the delivered mp4 was replaced */
  reRendered: boolean;
  /** gates that contributed NO measurement to the verdict (crashed on every
   *  pass they ran). "No errors" from a run with a crashed gate is not a
   *  clean bill — `check` refuses the ✓ on it. */
  crashed: string[];
};

/** `make` withholds the healing re-render from a take that skipped steps
 *  under strict: the skipped-steps exit 2 fires regardless of anything a
 *  re-render could fix, so the render minutes buy nothing. */
export const healingWithheld = (skippedSteps: number, strict: boolean): boolean =>
  skippedSteps > 0 && strict;

const countErrors = (issues: CompositionIssue[]): number =>
  issues.filter((i) => i.severity === "error").length;

type GateRun = { issues: CompositionIssue[]; crashed: boolean };
type Pass = { check: GateRun; cursor: GateRun };

export async function runPostShootGates(io: PostShootIO): Promise<PostShootResult> {
  const gate = async (name: string, run: () => Promise<CompositionIssue[]>): Promise<GateRun> => {
    try {
      return { issues: await run(), crashed: false };
    } catch (e) {
      io.warn(`${name} did not run: ${e instanceof Error ? e.message : e}`);
      return { issues: [], crashed: true };
    }
  };
  const pass = async (): Promise<Pass> => ({
    check: await gate("take checks", io.checkTake),
    cursor: await gate("cursor audit", io.auditCursor),
  });
  const verdict = (p: Pass, reRendered: boolean): PostShootResult => {
    const issues = [...p.check.issues, ...p.cursor.issues];
    return {
      issues,
      errors: countErrors(issues),
      reRendered,
      crashed: [
        ...(p.check.crashed ? ["take checks"] : []),
        ...(p.cursor.crashed ? ["cursor audit"] : []),
      ],
    };
  };

  const first = await pass();
  io.onFindings([...first.check.issues, ...first.cursor.issues], "post-shoot");
  const firstCursorErrors = countErrors(first.cursor.issues);
  if (!(firstCursorErrors > 0 && io.reRender)) return verdict(first, false);

  // The transient-or-real fork: one re-render decides which this is.
  io.log(
    "the cursor audit failed — re-rendering once from the frozen capture (a transient renderer misdraw heals; a repeat means the renderer disagrees with its own math) …",
  );
  try {
    await io.reRender();
  } catch (e) {
    io.warn(
      `the re-render failed (${e instanceof Error ? e.message : e}) — keeping the first audit's findings`,
    );
    return verdict(first, false);
  }
  const second = await pass();
  // A gate that crashed on the re-audit keeps its first-pass measurement:
  // the verdict may never improve because a re-measure failed to happen.
  const carried: Pass = {
    check: second.check.crashed ? first.check : second.check,
    cursor: second.cursor.crashed ? first.cursor : second.cursor,
  };
  io.onFindings([...carried.check.issues, ...carried.cursor.issues], "re-audit");
  io.log(
    second.cursor.crashed
      ? "re-audit could not re-measure the cursor — keeping the first audit's findings (a re-render that cannot be verified is not a heal)"
      : countErrors(second.cursor.issues) > 0
        ? "re-audit: the drawn cursor is STILL off — the renderer disagrees with its own math on this take; that needs a look, not another retry"
        : "re-audit: cursor clean — the misdraw was transient; the delivered mp4 is now the re-render",
  );
  return verdict(carried, true);
}
