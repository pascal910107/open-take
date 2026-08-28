// lintPlan: a structural check on an agent-authored TakePlan BEFORE it drives
// a capture. Plans arrive as bare JSON (`JSON.parse(...) as TakePlan` gives no
// runtime shape guarantee), and the engine's policy on a malformed step is to
// no-op or skip rather than throw — so a structural defect ships as silently
// missing footage, minutes later. This gives a millisecond, field-specific
// verdict first. It never changes the plan; it only reports.
//
// Severity (mirrors compositor/validate.ts):
//   "error" — the capture would be wrong: a step that silently does nothing
//             (a wait without `ms`) or gets skipped (no locatable target).
//   "warn"  — suspect, but may be intentional. The capture runs as-is.
//
// The reader of these messages is usually a model retrying a repair, so they
// TEACH the step's shape instead of just naming the field — measured on a
// 48-run repair benchmark, teaching copy converged 39/44 plans on one retry
// where terse copy converged 24/44. The two defects that dominated that
// benchmark get the fullest copy: a wait paced by `duration` (never read — the
// wait silently does not happen) and a `type` whose content sits in `text`,
// the TARGET field (element not found — the step is skipped).

import type { TakeStep } from "./types";

export type PlanIssue = {
  severity: "error" | "warn";
  /** dotted/indexed field path, e.g. "steps[3].ms" */
  path: string;
  message: string;
  /** a concrete suggested correction the agent can apply */
  fix?: string;
};

type Action = TakeStep["action"];

// The exact key set of each step variant, transcribed from the TakeStep union
// (types.ts is the ground truth). Keyed as Record<Action, …> so an action
// added there refuses to compile here until its fields are listed — the
// unknown-key check must never drift behind the schema it polices.
const STEP_FIELDS: Record<Action, readonly string[]> = {
  click: ["action", "selector", "text", "note", "caption", "settleMs", "zoom"],
  type: [
    "action",
    "selector",
    "text",
    "value",
    "clear",
    "perCharMs",
    "note",
    "caption",
    "settleMs",
    "zoom",
  ],
  drag: [
    "action",
    "selector",
    "text",
    "from",
    "toSelector",
    "toText",
    "to",
    "path",
    "durationMs",
    "note",
    "caption",
    "settleMs",
    "zoom",
  ],
  dropFiles: [
    "action",
    "paths",
    "toSelector",
    "toText",
    "to",
    "from",
    "path",
    "durationMs",
    "note",
    "caption",
    "settleMs",
    "zoom",
  ],
  scroll: ["action", "dy", "toSelector", "toText", "durationMs", "note", "caption", "settleMs"],
  hover: ["action", "selector", "text", "durationMs", "note", "caption", "settleMs", "zoom"],
  press: [
    "action",
    "keys",
    "selector",
    "text",
    "durationMs",
    "note",
    "caption",
    "settleMs",
    "zoom",
  ],
  navigate: ["action", "url", "hrefFrom", "query", "note", "settleMs"],
  select: ["action", "selector", "text", "value", "note", "caption", "settleMs", "zoom"],
  look: ["action", "selector", "text", "durationMs", "note", "caption", "settleMs", "zoom"],
  wait: ["action", "ms"],
};
const ACTIONS = Object.keys(STEP_FIELDS) as readonly Action[];

const PLAN_FIELDS = ["url", "viewport", "startCursor", "steps"] as const;
const ZOOMS = ["never", "auto", "always"] as const;

// The wait teaching line. `sleep(step.ms)` is the ENTIRE wait implementation
// (cdp-capture.ts), so any other field is dead weight and a missing `ms`
// sleeps for undefined — i.e. not at all.
const WAIT_SHAPE =
  'a wait step is exactly {"action":"wait","ms":<integer milliseconds>} and the engine reads ONLY `ms` — `duration`/`durationMs`/`value`/`settleMs` on a wait are never read';

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isPoint = (v: unknown): v is { x: number; y: number } => isObj(v) && isNum(v.x) && isNum(v.y);

/** Render a value into a message. Truncated: plans embed whole paragraphs. */
const show = (v: unknown): string => {
  const s = v === undefined ? "undefined" : (JSON.stringify(v) ?? String(v));
  return s.length > 48 ? `${s.slice(0, 45)}…` : s;
};

/** A number usable as `ms`/`dy`, recovered from a number or a numeric string. */
const toInt = (v: unknown): number | undefined => {
  const n =
    typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? Math.round(n) : undefined;
};

function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 3; // beyond anything suggested
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++)
      cur[j] = Math.min(
        prev[j]! + 1,
        cur[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    prev = cur;
  }
  return prev[b.length]!;
}

/** The field name a key most plausibly misspells — case-fold first, then a
 *  small edit distance, scaled down so short names ("dy", "to") can only match
 *  a one-letter slip and never collide by accident. */
function nearestField(key: string, fields: readonly string[]): string | undefined {
  const k = key.toLowerCase();
  for (const f of fields) if (f.toLowerCase() === k) return f;
  let best: string | undefined;
  let bestD = 3;
  for (const f of fields) {
    const cap = Math.min(f.length, key.length) >= 5 ? 2 : 1;
    const d = editDistance(k, f.toLowerCase());
    if (d <= cap && d < bestD) {
      bestD = d;
      best = f;
    }
  }
  return best;
}

/** Fields this step cannot run without, GIVEN what it already has — an unknown
 *  key near one of these is a misspelling of something load-bearing (error),
 *  not an extra to tidy up (warn). selector/text travel as a pair: either one
 *  satisfies the target requirement. */
function requiredNow(action: Action, s: Record<string, unknown>): string[] {
  const req: string[] = [];
  if (action === "type" || action === "select") req.push("value");
  if (action === "press") req.push("keys");
  if (action === "dropFiles") req.push("paths");
  const needsTarget =
    action === "click" ||
    action === "hover" ||
    action === "look" ||
    action === "type" ||
    action === "select";
  if (needsTarget && !isStr(s.selector) && !isStr(s.text)) req.push("selector", "text");
  return req;
}

export function lintPlan(plan: unknown): PlanIssue[] {
  const issues: PlanIssue[] = [];
  const err = (path: string, message: string, fix?: string) =>
    issues.push({ severity: "error", path, message, fix });
  const warn = (path: string, message: string, fix?: string) =>
    issues.push({ severity: "warn", path, message, fix });

  if (!isObj(plan)) {
    err(
      "plan",
      `plan is not an object (got ${show(plan)}) — a TakePlan is {"url":"<the running app>","steps":[…]}`,
      'start from {"url":"http://localhost:3000","steps":[{"action":"click","text":"Get started"}]}',
    );
    return issues;
  }

  if (!isStr(plan.url))
    err(
      "url",
      plan.url === undefined
        ? "url is missing — the running app the take opens"
        : `url must be a non-empty string (got ${show(plan.url)}) — the running app the take opens`,
      'set url to the app\'s address, e.g. "http://localhost:3000"',
    );

  const vp = plan.viewport;
  if (vp !== undefined && !(isObj(vp) && Number.isInteger(vp.width) && Number.isInteger(vp.height)))
    err(
      "viewport",
      `viewport must be {"width":<int>,"height":<int>} in CSS px (got ${show(vp)})`,
      isObj(vp) && isNum(vp.width) && isNum(vp.height)
        ? `rewrite as {"width":${Math.round(vp.width)},"height":${Math.round(vp.height)}}`
        : 'use e.g. {"width":1280,"height":800}, or drop viewport for the default',
    );

  const sc = plan.startCursor;
  if (sc !== undefined && !isPoint(sc))
    err(
      "startCursor",
      `startCursor must be a point {"x":<px>,"y":<px>} in viewport CSS px (got ${show(sc)})`,
      'use e.g. {"x":640,"y":400}, or drop startCursor for the default',
    );

  // Top-level unknown keys — before the empty-steps early return, so a plan
  // whose steps sit under a misspelled key is diagnosed as the misspelling it
  // is, not just "steps missing".
  const steps = plan.steps;
  let stepsMisspelled = false;
  for (const k of Object.keys(plan)) {
    if ((PLAN_FIELDS as readonly string[]).includes(k)) continue;
    const near = nearestField(k, PLAN_FIELDS);
    if (near === "steps" && !Array.isArray(steps)) {
      stepsMisspelled = true;
      err(
        k,
        `\`${k}\` looks like a misspelling of \`steps\` — as written the plan has no steps array, so there is nothing to drive`,
        `rename \`${k}\` to \`steps\``,
      );
    } else {
      warn(
        k,
        `\`${k}\` is not a TakePlan field — nothing reads it`,
        near
          ? `rename \`${k}\` to \`${near}\``
          : `remove it — a plan's fields are: ${PLAN_FIELDS.join(", ")}`,
      );
    }
  }

  if (!Array.isArray(steps) || steps.length === 0) {
    if (!stepsMisspelled)
      err(
        "steps",
        steps === undefined
          ? "steps is missing — a plan drives at least one step"
          : `steps must be a non-empty array (got ${show(steps)})`,
        'add a steps array, e.g. [{"action":"click","text":"Get started"}]',
      );
    return issues;
  }

  for (let i = 0; i < steps.length; i++) {
    const s: unknown = steps[i];
    const p = `steps[${i}]`;
    if (!isObj(s)) {
      err(
        p,
        `step is not an object (got ${show(s)}) — every step is {"action":"<name>", …}`,
        `actions: ${ACTIONS.join(", ")}`,
      );
      continue;
    }

    const a = s.action;
    if (typeof a !== "string" || !(ACTIONS as readonly string[]).includes(a)) {
      const near = typeof a === "string" ? nearestField(a, ACTIONS) : undefined;
      err(
        `${p}.action`,
        a === undefined
          ? `step has no action — the vocabulary is ${ACTIONS.join(" | ")}`
          : `unknown action ${show(a)} — the vocabulary is ${ACTIONS.join(" | ")}`,
        near ? `did you mean "${near}"?` : `pick one of: ${ACTIONS.join(", ")}`,
      );
      continue; // without a variant there is no field set to check against
    }
    const action = a as Action;

    if (action === "wait") {
      lintWait(s, p, err, warn);
      continue;
    }

    const fields = STEP_FIELDS[action];
    const required = requiredNow(action, s);
    // required fields already reported via a misspelled key — the rename fix
    // is strictly better than a second "it is missing" error would be
    const covered = new Set<string>();
    for (const k of Object.keys(s)) {
      if (fields.includes(k)) continue;
      if (k === "zoom") {
        // only scroll/navigate lack `zoom`, and there its absence is design
        warn(
          `${p}.zoom`,
          `a ${action} step takes no \`zoom\` — it plays full-view by design${action === "scroll" ? " (the content pans; the camera holds)" : ""}, so this is never read`,
          "remove it",
        );
        continue;
      }
      const near = nearestField(k, fields);
      if (near && required.includes(near) && s[near] === undefined) {
        covered.add(near);
        if (near === "selector" || near === "text") {
          covered.add("selector");
          covered.add("text");
        }
        err(
          `${p}.${k}`,
          `\`${k}\` looks like a misspelling of \`${near}\` — a ${action} step requires \`${near}\`, and as written it is missing while \`${k}\` is never read`,
          `rename \`${k}\` to \`${near}\``,
        );
      } else {
        warn(
          `${p}.${k}`,
          `\`${k}\` is not a field of a ${action} step — the engine never reads it, so it changes nothing`,
          near
            ? `rename \`${k}\` to \`${near}\``
            : `remove it — a ${action} step's fields are: ${fields.join(", ")}`,
        );
      }
    }

    if (
      fields.includes("zoom") &&
      s.zoom !== undefined &&
      !(typeof s.zoom === "string" && (ZOOMS as readonly string[]).includes(s.zoom))
    )
      err(
        `${p}.zoom`,
        `zoom must be one of "never" | "auto" | "always" (got ${show(s.zoom)})`,
        '"auto" lets the heuristic decide; "never" keeps full view; "always" forces the fit-zoom',
      );

    const target = isStr(s.selector) || isStr(s.text);
    const needTarget = () => {
      if (target || covered.has("text")) return;
      // a present-but-mistyped target gets its own message: "add `text`" to a
      // step that already HAS text:123 would send a retry in a circle
      const misTyped = s.selector !== undefined ? "selector" : s.text !== undefined ? "text" : null;
      if (misTyped) {
        err(
          `${p}.${misTyped}`,
          `\`${misTyped}\` must be a string (got ${show(s[misTyped])}) — the engine's locator only takes strings`,
          `quote it: "${misTyped}":"…"`,
        );
        return;
      }
      const what =
        action === "type"
          ? "the field to type into"
          : action === "select"
            ? "the <select> to pick from"
            : "a target element";
      err(
        p,
        `${action} step has neither \`selector\` nor \`text\` — the engine cannot locate ${what}, so the step is skipped`,
        "add `selector` (a CSS selector) or `text` (the element's accessible name)",
      );
    };

    switch (action) {
      case "click":
      case "hover":
      case "look":
        needTarget();
        break;

      case "type":
      case "select": {
        needTarget();
        if (covered.has("value")) break;
        const what =
          action === "type"
            ? "the string to type"
            : "the option to pick (its value, or its visible label)";
        if (s.value === undefined) {
          // THE benchmark-dominant defect: content written into `text` (the
          // TARGET field) and no `value` — teach which field carries which.
          err(
            `${p}.value`,
            `${action} step has no \`value\` — \`value\` is ${what}; the TARGET element goes in \`selector\` (CSS) or \`text\` (its accessible name). Content written into \`text\` makes the engine search for an element NAMED that content — not found, so the step is skipped`,
            isStr(s.text)
              ? `if ${show(s.text)} is the content, rewrite as {"action":"${action}","value":${JSON.stringify(s.text)},"text":"<the target's accessible name>"} (or \`selector\`: its CSS)`
              : `add value (${what})`,
          );
        } else if (typeof s.value !== "string") {
          err(
            `${p}.value`,
            `value must be a string — ${what} (got ${show(s.value)})`,
            `rewrite as "value": ${JSON.stringify(String(s.value))}`,
          );
        }
        break;
      }

      case "press":
        if (!covered.has("keys") && !isStr(s.keys))
          err(
            `${p}.keys`,
            s.keys === undefined
              ? 'press step has no `keys` — the chord to press: a named key ("Enter", "Escape", "ArrowDown") or a "+"-joined combo ("Meta+k", "Control+Shift+p")'
              : `keys must be a single chord string (got ${show(s.keys)}) — a named key ("Enter") or a "+"-joined combo ("Meta+k")`,
            'add keys, e.g. {"action":"press","keys":"Enter"}',
          );
        break;

      case "scroll":
        if (s.dy !== undefined && !isNum(s.dy)) {
          const n = toInt(s.dy);
          err(
            `${p}.dy`,
            `dy must be a number of viewport px, positive = down (got ${show(s.dy)})`,
            n !== undefined
              ? `set dy to ${n} (a number, not a string)`
              : "set dy to a number, e.g. 600",
          );
        } else if (s.dy === undefined && !isStr(s.toSelector) && !isStr(s.toText)) {
          err(
            p,
            "scroll step has none of `toSelector`/`toText`/`dy` — nothing names where to scroll",
            "add `dy` (viewport px, positive = down), or `toSelector`/`toText` to scroll until that element is centred",
          );
        }
        break;

      case "drag": {
        const pathOk =
          Array.isArray(s.path) && s.path.length > 0 && (s.path as unknown[]).every(isPoint);
        if (s.path !== undefined && !pathOk)
          err(
            `${p}.path`,
            `path must be a non-empty array of viewport points {"x":<px>,"y":<px>} (got ${show(s.path)})`,
            'e.g. "path":[{"x":200,"y":300},{"x":420,"y":180}]',
          );
        const fromBad = s.from !== undefined && !isPoint(s.from);
        if (fromBad)
          err(
            `${p}.from`,
            `from must be a viewport point {"x":<px>,"y":<px>} (got ${show(s.from)})`,
            'e.g. "from":{"x":320,"y":240}',
          );
        const toBad = s.to !== undefined && !isPoint(s.to);
        if (toBad)
          err(
            `${p}.to`,
            `to must be a viewport point {"x":<px>,"y":<px>} (got ${show(s.to)})`,
            'e.g. "to":{"x":760,"y":420}',
          );
        // a freehand `path` carries its own endpoints (the capture falls back
        // to path[0]/path[last]), so a path-only drag is complete. A PRESENT
        // but malformed path already owns this step's error — piling on
        // "no start / no end" would prescribe the wrong repair.
        if (
          !fromBad &&
          s.from === undefined &&
          !target &&
          s.path === undefined &&
          !covered.has("text")
        )
          err(
            p,
            "drag step has no start — give `selector`/`text` (the element to pick up) or `from` (a viewport point), else the step is skipped",
            'add e.g. "from":{"x":320,"y":240}, or name the element to pick up',
          );
        if (
          !toBad &&
          s.to === undefined &&
          !isStr(s.toSelector) &&
          !isStr(s.toText) &&
          s.path === undefined
        )
          err(
            p,
            "drag step has no end — give `toSelector`/`toText` (the drop target) or `to` (a viewport point), else the step is skipped",
            'add e.g. "to":{"x":760,"y":420}, or name the drop target',
          );
        break;
      }

      case "dropFiles": {
        const pathsOk =
          Array.isArray(s.paths) &&
          s.paths.length > 0 &&
          (s.paths as unknown[]).every((x) => isStr(x));
        if (!covered.has("paths") && !pathsOk)
          err(
            `${p}.paths`,
            s.paths === undefined
              ? "dropFiles step has no `paths` — the real files to drag in: a non-empty array of file paths (resolved against the process cwd)"
              : `paths must be a non-empty array of file-path strings (got ${show(s.paths)})`,
            'add paths, e.g. {"action":"dropFiles","paths":["./assets/logo.png"],"toText":"Drop files here"}',
          );
        break;
      }

      case "navigate":
        if (
          s.hrefFrom !== undefined &&
          !(isObj(s.hrefFrom) && (isStr(s.hrefFrom.selector) || isStr(s.hrefFrom.text)))
        )
          err(
            `${p}.hrefFrom`,
            `hrefFrom names the link whose href to follow and needs \`selector\` or \`text\` (got ${show(s.hrefFrom)}) — without one the step is skipped`,
            'use "hrefFrom":{"text":"<the link\'s accessible name>"}',
          );
        // nav.ts spreads Object.entries(query) onto the URL — a string here
        // would silently append `?0=s&1=p&…` instead of failing
        if (
          s.query !== undefined &&
          !(isObj(s.query) && Object.values(s.query).every((v) => isStr(v)))
        )
          err(
            `${p}.query`,
            `query must be an object of string params (got ${show(s.query)}) — anything else appends garbage to the destination URL`,
            'use e.g. "query":{"speed":"3"}',
          );
        break;
    }
  }

  return issues;
}

// The benchmark's #1 defect gets its own path: a wait paced by any field but
// `ms`. When another field carries a usable number, the fix is COMPUTED — the
// exact rewrite, value carried over — because that is what a retrying model
// can apply verbatim.
function lintWait(
  s: Record<string, unknown>,
  p: string,
  err: (path: string, message: string, fix?: string) => void,
  warn: (path: string, message: string, fix?: string) => void,
): void {
  const unknown = Object.keys(s).filter((k) => !STEP_FIELDS.wait.includes(k));
  let carrier: string | undefined;
  if (!Number.isInteger(s.ms)) {
    carrier = unknown.find((k) => toInt(s[k]) !== undefined);
    const n = carrier ? toInt(s[carrier]) : toInt(s.ms);
    if (carrier) {
      err(
        `${p}.${carrier}`,
        `\`${carrier}\` looks like it means \`ms\`, but ${WAIT_SHAPE} — so this wait silently does not happen`,
        `rewrite as {"action":"wait","ms":${n}}`,
      );
    } else if (s.ms !== undefined) {
      err(
        `${p}.ms`,
        `ms must be an integer count of milliseconds (got ${show(s.ms)}) — ${WAIT_SHAPE}`,
        n !== undefined
          ? `rewrite as {"action":"wait","ms":${n}}`
          : "set ms to a whole number of milliseconds, e.g. 800",
      );
    } else {
      err(
        `${p}.ms`,
        `wait step has no \`ms\` — ${WAIT_SHAPE}, so this wait silently does not happen`,
        'add ms, e.g. {"action":"wait","ms":800}',
      );
    }
  }
  for (const k of unknown) {
    if (k === carrier) continue;
    warn(`${p}.${k}`, `\`${k}\` on a wait is never read — ${WAIT_SHAPE}`, "remove it");
  }
}
