// Pre-capture target resolution — the 2-second gate in front of the 60-second
// shoot. Resolves every plan target against the page AS LOADED with the exact
// locator semantics the capture will use (same candidate sets, same pick()),
// so a plan whose opening steps can never resolve is refused BEFORE the
// screencast exists — the same contract as the dead-URL check in cdp-capture.
//
// The page is stateful, so the gate is deliberately state-honest:
//   - steps up to and including the FIRST state-changing action run against
//     the initial DOM by construction — a miss there is a certainty, and an
//     error;
//   - a miss after that point is only "not in the initial DOM": a prior step
//     may reveal it (a toolbar that appears once editing starts), so it is a
//     warning, and the capture-time skip (plus the strict default exit) stays
//     the authority.
// A measured motivator: 12/12 model-repaired plans of one broken take kept a
// first click that resolves to a sidebar thumbnail instead of the headline —
// every later beat then dies "target not found" after a full minute of
// capture. The ambiguity/zero-size warnings here are how that reads BEFORE
// the shoot.
import {
  BOX_CANDIDATES,
  CLICK_CANDIDATES,
  FIELD_CANDIDATES,
  NAME_JS,
  SCROLL_CANDIDATES,
} from "./capture";
import type { TakePlan } from "./types";

export type PrecheckIssue = {
  severity: "error" | "warn";
  /** dotted/indexed field path, e.g. "steps[3].selector" */
  path: string;
  message: string;
  /** a concrete suggested correction the author can apply */
  fix?: string;
};

type TargetSpec = {
  step: number;
  action: string;
  field: string; // which plan field named the target (selector/text/toSelector/…)
  kind: "selector" | "text";
  value: string;
  /** true = runs against the initial DOM by construction (miss ⇒ certainty) */
  cold: boolean;
  /** press reveals are named so the ZOOM can frame them — they exist only
   *  AFTER the press by definition, so a miss is never even a warning */
  revealOnly?: boolean;
};

// Any action that can change what the page shows ends the cold prefix. hover
// and scroll are included on purpose: a hover can open a menu, a scroll can
// mount lazy content — after either, absence from the initial DOM proves
// nothing.
const MUTATING = new Set([
  "click",
  "type",
  "press",
  "select",
  "drag",
  "dropFiles",
  "navigate",
  "hover",
  "scroll",
]);

/** Every named target in the plan, in step order, tagged cold/late. */
export function planTargets(steps: TakePlan["steps"]): TargetSpec[] {
  const out: TargetSpec[] = [];
  let cold = true;
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i] as Record<string, unknown>;
    const action = String(s.action ?? "");
    const add = (field: string, kind: "selector" | "text", revealOnly?: boolean) => {
      const v = s[field];
      if (typeof v === "string" && v)
        out.push({
          step: i,
          action,
          field,
          kind,
          value: v,
          cold: cold && !revealOnly,
          ...(revealOnly ? { revealOnly } : {}),
        });
    };
    switch (action) {
      case "click":
      case "hover":
      case "look":
      case "type":
      case "select":
        add("selector", "selector");
        add("text", "text");
        break;
      case "press":
        // the reveal target exists only after the press lands
        add("selector", "selector", true);
        add("text", "text", true);
        break;
      case "scroll":
        add("toSelector", "selector");
        add("toText", "text");
        break;
      case "drag":
        add("selector", "selector");
        add("text", "text");
        add("toSelector", "selector");
        add("toText", "text");
        break;
      default:
        break; // wait / navigate name no in-page target to resolve
    }
    if (MUTATING.has(action)) cold = false;
  }
  return out;
}

/** The candidate set the ENGINE's by-text locator queries for this action —
 *  imported from capture.ts so the probe and the real resolver cannot drift. */
function textCandidates(action: string): string {
  switch (action) {
    case "type":
      return FIELD_CANDIDATES; // focusFieldByTextJs
    case "click":
      return CLICK_CANDIDATES; // clickByTextJs
    case "scroll":
      return SCROLL_CANDIDATES; // scrollDeltaByTextJs
    default:
      return BOX_CANDIDATES; // hover / look / drag endpoints / press reveals → boxByTextJs
  }
}

/** One page eval: resolve a target and DESCRIBE the outcome (no side effects). */
export function probeJs(kind: "selector" | "text", value: string, action: string): string {
  const v = JSON.stringify(value);
  const desc =
    `function desc(m){if(!m)return null;var r=m.getBoundingClientRect();` +
    `return {tag:m.tagName,w:Math.round(r.width),h:Math.round(r.height)};}`;
  if (kind === "selector")
    return (
      `(function(){${desc}` +
      `var all;try{all=Array.prototype.slice.call(document.querySelectorAll(${v}));}` +
      `catch(e){return JSON.stringify({err:String(e.message||e)});}` +
      `return JSON.stringify({count:all.length,first:desc(all[0]||null)});})()`
    );
  if (action === "select")
    // a <select> is located by its OWN semantics (selectOptionJs): aria-label
    // equal to the name, a label[for] pointing at it, or a wrapping <label> —
    // pick() over form fields would never match one.
    return (
      `(function(){${desc}var n=${v};` +
      `var els=Array.prototype.slice.call(document.querySelectorAll('select'));` +
      `var hits=els.filter(function(e){var a=(e.getAttribute('aria-label')||'').trim();if(a===n)return true;` +
      `var id=e.id;if(id){var l=document.querySelector('label[for="'+id+'"]');if(l&&(l.textContent||'').trim().indexOf(n)>=0)return true;}` +
      `var p=e.closest('label');if(p&&(p.textContent||'').trim().indexOf(n)>=0)return true;return false;});` +
      `return JSON.stringify({count:hits.length?1:0,exact:hits.length,first:desc(hits[0]||null)});})()`
    );
  const set = textCandidates(action);
  return (
    `(function(){${desc}${NAME_JS}` +
    `var els=Array.prototype.slice.call(document.querySelectorAll('${set}'));` +
    `var m=pick(els,${v});` +
    `var exact=0;for(var i=0;i<els.length;i++){if(names(els[i]).indexOf(${v})!==-1)exact++;}` +
    `return JSON.stringify({count:m?1:0,exact:exact,first:desc(m)});})()`
  );
}

type Probe = {
  err?: string;
  count?: number;
  exact?: number;
  first?: { tag: string; w: number; h: number } | null;
};

/** Resolve every plan target through `evalJson` (a Runtime.evaluate wrapper)
 *  and grade the outcomes. Cold-prefix misses get ONE retry after `retryMs` —
 *  a hydration-slow page may mount its controls a beat after load. */
export async function precheckPlan(
  steps: TakePlan["steps"],
  evalJson: (js: string) => Promise<unknown>,
  opts?: { retryMs?: number; sleep?: (ms: number) => Promise<void> },
): Promise<PrecheckIssue[]> {
  const sleep = opts?.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const targets = planTargets(steps);
  const probes = new Map<TargetSpec, Probe>();
  const probe = async (t: TargetSpec): Promise<Probe> =>
    ((await evalJson(probeJs(t.kind, t.value, t.action))) ?? {}) as Probe;
  for (const t of targets) probes.set(t, await probe(t));

  // One bounded retry for every miss — a hydration-slow page mounts content a
  // beat after load, and a stale first probe would mislabel targets that ARE
  // in the initial DOM (only the cold grading below turns a miss into an
  // error; the retry just keeps both tiers honest).
  const misses = targets.filter((t) => !probes.get(t)?.err && !probes.get(t)?.count);
  if (misses.length) {
    await sleep(opts?.retryMs ?? 1500);
    for (const t of misses) probes.set(t, await probe(t));
  }

  const issues: PrecheckIssue[] = [];
  // Late-bound misses are EXPECTED on a healthy plan (every post-reveal step
  // has one), so they aggregate into a single advisory instead of one line
  // per step — per-step warnings on a good plan would train authors to
  // scroll past this section, which is how warnings die.
  const lateMisses: TargetSpec[] = [];
  for (const t of targets) {
    const p = probes.get(t) ?? {};
    const path = `steps[${t.step}].${t.field}`;
    const name = `${t.action} ${JSON.stringify(t.value)}`;
    if (p.err) {
      issues.push({
        severity: "error",
        path,
        message: `${name}: invalid selector — the page rejected it (${p.err})`,
        fix: "fix the selector syntax; the capture would skip every use of it",
      });
      continue;
    }
    if (!p.count) {
      if (t.revealOnly) continue; // exists only after the press, by design
      if (t.cold) {
        issues.push({
          severity: "error",
          path,
          message:
            `${name}: target not found in the page as loaded — this step runs before anything ` +
            `has changed the page, so it is CERTAIN to be skipped. Refusing in seconds what ` +
            `would fail after the full capture.`,
          fix:
            "point it at an element that exists at load (`open-take inspect <url>` lists them), " +
            "or move it after the step that reveals it",
        });
      } else {
        lateMisses.push(t);
      }
      continue;
    }
    if (t.kind === "selector" && (p.count ?? 0) > 1) {
      const z =
        p.first && (p.first.w === 0 || p.first.h === 0)
          ? " — and the first match is ZERO-SIZE"
          : "";
      issues.push({
        severity: "warn",
        path,
        message:
          `${name}: matches ${p.count} nodes; the engine takes the FIRST in document order${z}. ` +
          `A sidebar thumbnail or an off-screen clone outranking the real element is exactly ` +
          `how a whole take dies.`,
        fix: "qualify the selector until it matches once (e.g. scope it to `main`)",
      });
      continue;
    }
    if (t.kind === "text" && (p.exact ?? 0) > 1) {
      issues.push({
        severity: "warn",
        path,
        message: `${name}: ${p.exact} elements carry this exact accessible name; the engine takes the first in document order`,
        fix: "use a more specific name, or a CSS selector scoped to the intended region",
      });
      continue;
    }
    if (p.first && (p.first.w === 0 || p.first.h === 0)) {
      issues.push({
        severity: "warn",
        path,
        message: `${name}: resolves to a zero-size element — the cursor has nowhere real to land`,
      });
    }
  }
  if (lateMisses.length) {
    issues.push({
      severity: "warn",
      path: "steps",
      message:
        `${lateMisses.length} target${lateMisses.length === 1 ? " is" : "s are"} not in the initial DOM ` +
        `(${lateMisses.map((t) => `steps[${t.step}] ${JSON.stringify(t.value)}`).join(", ")}) — ` +
        `fine if earlier steps reveal them; any that never appears is SKIPPED at capture time ` +
        `(and the run exits non-zero)`,
    });
  }
  return issues;
}
