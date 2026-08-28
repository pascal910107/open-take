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
  /** false = the capture will never consult this field, because the step also
   *  carries the one this action resolves first (see FIELD_ORDER) */
  used: boolean;
};

// Which field the capture actually resolves when a step names more than one.
// Read off cdp-capture / capture.ts, verb by verb: click, type, look, hover
// and press try `text` first and do NOT fall back when it misses; `select`
// (selectOptionJs) and `scroll` (scrollDeltaSelectorJs) try the SELECTOR
// first; a `drag` endpoint takes a literal point, then `selector`, then
// `text`. Grading a field the engine never reads would refuse a plan that
// captures fine.
const FIELD_ORDER: Record<string, string[]> = {
  click: ["text", "selector"],
  type: ["text", "selector"],
  look: ["text", "selector"],
  hover: ["text", "selector"],
  press: ["text", "selector"],
  select: ["selector", "text"],
  scroll: ["toSelector", "toText"],
  drag: ["selector", "text"],
};
const DRAG_TO_ORDER = ["toSelector", "toText"];

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
    const has = (f: string) => typeof s[f] === "string" && s[f];
    /** the first field of this group the step actually carries */
    const winner = (order: string[]) => order.find(has);
    const order = FIELD_ORDER[action];
    const dragTo = action === "drag" && (s.to as unknown) ? null : winner(DRAG_TO_ORDER);
    const primary = action === "drag" && (s.from as unknown) ? null : winner(order ?? []);
    // an action with no precedence entry gets every field checked — a new
    // verb must not silently switch the gate off for itself
    const isUsed = (field: string) => !order || field === primary || field === dragTo;
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
          used: isUsed(field),
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
      case "drag": {
        // With a `path`, the stroke is the waypoints and each element endpoint
        // has them as a fallback (resolvePoint(...) ?? pathPts[0]) — a miss
        // costs nothing, so nothing here is load-bearing.
        const hasPath = Array.isArray(s.path) && (s.path as unknown[]).length > 0;
        if (!hasPath) {
          add("selector", "selector");
          add("text", "text");
          add("toSelector", "selector");
          add("toText", "text");
        }
        break;
      }
      case "navigate": {
        // navigate DOES resolve an in-page target: hrefFrom names the link
        // whose real href the demo follows — selector first, then by-text
        // over the link candidate set (capture.ts hrefSelectorJs/hrefByTextJs).
        // A cold miss here is the worst cascade in the file's header: every
        // later step is excused as "late", and the take shoots zero beats.
        const hf = s.hrefFrom as { selector?: string; text?: string } | undefined;
        const hfField = hf?.selector ? "selector" : hf?.text ? "text" : null;
        for (const [sub, kind] of [
          ["selector", "selector"],
          ["text", "text"],
        ] as const) {
          const v = hf?.[sub];
          if (typeof v === "string" && v)
            out.push({
              step: i,
              action,
              field: `hrefFrom.${sub}`,
              kind,
              value: v,
              cold,
              used: sub === hfField,
            });
        }
        break;
      }
      default:
        break; // wait names no in-page target to resolve
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
    case "navigate":
      return "a,button,[role=link],[role=button],[aria-label],[title]"; // hrefByTextJs
    default:
      return BOX_CANDIDATES; // hover / look / drag endpoints / press reveals → boxByTextJs
  }
}

/** One page eval: resolve a target and DESCRIBE the outcome (no side effects). */
export function probeJs(kind: "selector" | "text", value: string, action: string): string {
  const v = JSON.stringify(value);
  const desc =
    `function desc(m){if(!m)return null;var r=m.getBoundingClientRect();` +
    `return {tag:m.tagName,w:Math.round(r.width),h:Math.round(r.height),` +
    `x:Math.round(r.x),y:Math.round(r.y),inMain:!!m.closest('main')};}`;
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
  // Alongside the pick itself: HOW it matched (an exact name vs a substring
  // buried in some clickable's textContent), and every element inside <main>
  // that actually carries this name — the C3.5 evidence. The intended element
  // (a headline, a paragraph) is typically NOT in the candidate set, which is
  // why a resolving target can still be the wrong node.
  return (
    `(function(){${desc}${NAME_JS}` +
    `var els=Array.prototype.slice.call(document.querySelectorAll('${set}'));` +
    `var m=pick(els,${v});` +
    `var exact=0;for(var i=0;i<els.length;i++){if(names(els[i]).indexOf(${v})!==-1)exact++;}` +
    `var how=m?(names(m).indexOf(${v})!==-1?'exact':'substring'):'none';` +
    // How much of the pick's own (shortest containing) name the value covers.
    // "Comments" naming a button whose name is "Comments3", or "Start free
    // trial" naming "Start free trial →", covers most of it — the author
    // ABBREVIATED the control's label. "Build slides" matched inside a
    // 200-char thumbnail blob covers a sliver — the author named something
    // else entirely. This ratio is what separates the two.
    `var share=how==='exact'?1:0,pn=null;` +
    `if(m&&how==='substring'){var mn=names(m);for(var k=0;k<mn.length;k++){` +
    `if(mn[k].indexOf(${v})!==-1&&(pn===null||mn[k].length<pn.length))pn=mn[k];}` +
    `if(pn)share=${v}.length/pn.length;}` +
    // Containment is how a plan names a fragment of a long paragraph, or a
    // headline the session has already edited — but only between names long
    // enough to be distinctive in BOTH directions: a two-letter label
    // "contained" in a sentence is a coincidence, not the author's intent.
    `function nm(e){var n=names(e),k;for(k=0;k<n.length;k++){if(n[k]===${v})return 'exact';}` +
    `if(${v}.length>6){for(k=0;k<n.length;k++){if(n[k].length>6&&` +
    `(n[k].indexOf(${v})!==-1||${v}.indexOf(n[k])!==-1))return 'contains';}}` +
    `return null;}` +
    `var inM=[],same=false,am=document.querySelectorAll('main *'),vwA=window.innerWidth*window.innerHeight;` +
    `for(var i=0;i<am.length;i++){var e=am[i],mk=nm(e);if(!mk)continue;` +
    // The pick wraps / sits inside the element that carries the name (a
    // clickable card around its own title, a link inside a heading): the
    // click lands on the thing the author named — no mismatch. The pick
    // MATCHING ITSELF proves nothing under substring semantics (every
    // substring pick's name contains the value by definition), so a self-hit
    // only exonerates on an exact name. Checked over EVERY match, before
    // any capping.
    `if(m&&e===m){if(mk==='exact')same=true;continue;}` +
    `if(m&&(m.contains(e)||e.contains(m))){same=true;continue;}` +
    `var d=desc(e);` +
    // display:none duplicates (responsive markup) and sr-only text measure
    // as nothing — they are not what a demo was aimed at
    `if(d.w<3||d.h<3)continue;` +
    // a containment hit the size of the stage is a container, not the element
    // the author named — every ancestor of the real target would match too
    `if(mk==='contains'&&d.w*d.h>vwA*0.25)continue;d.match=mk;inM.push(d);}` +
    // plausible intent: an exact name beats containment; among peers the
    // tightest box is the named element, its wrappers are noise
    `inM.sort(function(a,b){if(a.match!==b.match)return a.match==='exact'?-1:1;return a.w*a.h-b.w*b.h;});` +
    `return JSON.stringify({count:m?1:0,exact:exact,first:desc(m),how:how,` +
    `pickNameShare:Math.round(share*100)/100,pickName:pn?pn.slice(0,60):null,` +
    `pickIsNamed:same,mainMatches:inM.slice(0,4)});})()`
  );
}

type Landed = {
  tag: string;
  w: number;
  h: number;
  x?: number;
  y?: number;
  inMain?: boolean;
  match?: "exact" | "contains";
};
type Probe = {
  err?: string;
  count?: number;
  exact?: number;
  first?: Landed | null;
  /** how the by-text pick matched: an exact accessible name, or a substring */
  how?: "exact" | "substring" | "none";
  /** fraction of the pick's own (shortest containing) name the value covers:
   *  1 for an exact hit, ~0.9 for an abbreviated label ("Comments" naming
   *  "Comments3"), a sliver for a match inside some blob's textContent */
  pickNameShare?: number;
  /** the pick's shortest name containing the value (substring hits only) */
  pickName?: string | null;
  /** the pick wraps/sits inside an element carrying the name, or IS one exactly */
  pickIsNamed?: boolean;
  /** elements inside <main> that carry the target's name (C3.5 evidence) */
  mainMatches?: Landed[];
};

/** C3.5 parse-intent mismatch: the pick and the same-named in-main element
 *  disagree by more than a step's worth of geometry. Validated against the 36
 *  plans of the X5 corpus (23 poisoned targets). A pick that covers most of
 *  its own label (share >= 0.5) is the named control, abbreviated — for that
 *  shape only an EXACT in-main duplicate is evidence of anything; body copy
 *  merely mentioning the phrase is how landing pages talk about their own
 *  buttons. */
const FAR_PX = 150;
const ABBREVIATION_SHARE = 0.5;
function parseIntentMismatch(p: Probe): { pick: Landed; intended: Landed } | null {
  const pick = p.first;
  if (!pick || typeof pick.x !== "number" || typeof pick.y !== "number") return null;
  if (p.pickIsNamed) return null; // the pick is (or contains) the named element
  let matches = (p.mainMatches ?? []).filter(
    (m) => typeof m.x === "number" && typeof m.y === "number",
  );
  if ((p.pickNameShare ?? 0) >= ABBREVIATION_SHARE)
    matches = matches.filter((m) => m.match === "exact");
  if (!matches.length) return null;
  const cx = pick.x + pick.w / 2;
  const cy = pick.y + pick.h / 2;
  for (const m of matches) {
    // the pick IS one of the named elements — clean
    if (Math.abs(m.x! + m.w / 2 - cx) <= 5 && Math.abs(m.y! + m.h / 2 - cy) <= 5) return null;
  }
  const intended = matches[0]!; // exact-first, tightest-box-first (sorted in-page)
  const far =
    Math.abs(intended.x! + intended.w / 2 - cx) > FAR_PX ||
    Math.abs(intended.y! + intended.h / 2 - cy) > FAR_PX;
  return !pick.inMain || far ? { pick, intended } : null;
}

/** Resolve every plan target through `evalJson` (a Runtime.evaluate wrapper)
 *  and grade the outcomes. Cold-prefix misses get ONE retry after `retryMs` —
 *  a hydration-slow page may mount its controls a beat after load. */
export async function precheckPlan(
  steps: TakePlan["steps"],
  evalJson: (js: string) => Promise<unknown>,
  opts?: { retryMs?: number; sleep?: (ms: number) => Promise<void> },
): Promise<PrecheckIssue[]> {
  const sleep = opts?.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  // A field the capture will never read cannot break the take — probing it
  // would only produce verdicts about a resolution that never happens.
  const targets = planTargets(steps).filter((t) => t.used);
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
    // C3.5 — the target RESOLVES, so the existence check above stays quiet,
    // but it resolves to a different node than the element in <main> that
    // actually carries this name: the by-text lookup only queries the
    // action's clickable candidate set, so a headline's words match whatever
    // clickable merely CONTAINS them (measured: a sidebar page-thumbnail,
    // whose click navigates — the defect that sank a whole take). A cold
    // mismatch is a certainty by construction; a late one is graded on the
    // initial DOM, so it stays a warning. Three more conditions narrow the
    // ERROR tier to the shape that was actually measured — every one of the
    // 23 poisoned targets in the validation corpus is a SUBSTRING pick,
    // landing OUTSIDE <main>, whose value is a sliver of the picked blob's
    // name (share < 0.5) — so requiring all three costs no recall while
    // sparing the realistic look-alikes: a topbar control whose exact label
    // an in-main heading shares, an ABBREVIATED label ("Comments" naming the
    // header's "Comments3" badge button, "Start free trial" naming
    // "Start free trial →"), and two in-main elements far apart.
    // A press reveal target names what the ZOOM should frame AFTER the press,
    // so — like the miss above — the initial DOM says nothing about it.
    if (t.kind === "text" && !t.revealOnly) {
      const mm = parseIntentMismatch(p);
      if (mm) {
        const certain =
          t.cold &&
          p.how === "substring" &&
          !mm.pick.inMain &&
          (p.pickNameShare ?? 0) < ABBREVIATION_SHARE;
        issues.push({
          severity: certain ? "error" : "warn",
          path,
          message:
            `${name}: resolves to the WRONG element. The by-text lookup for ${t.action} ` +
            `searches only its candidate set and ${p.how === "substring" ? "substring-" : ""}matched a ` +
            `${mm.pick.w}x${mm.pick.h} ${mm.pick.tag.toLowerCase()} at (${mm.pick.x},${mm.pick.y})` +
            `${mm.pick.inMain ? "" : " OUTSIDE <main>"}` +
            `${p.pickName ? ` (its actual name: ${JSON.stringify(p.pickName)})` : ""}, ` +
            `while the element named ` +
            `${JSON.stringify(t.value.slice(0, 40))} is a ${mm.intended.tag.toLowerCase()} at ` +
            `(${mm.intended.x},${mm.intended.y}) inside <main>. The step would land on the impostor.`,
          fix:
            `target the in-main ${mm.intended.tag.toLowerCase()} with a CSS selector scoped to ` +
            "`main` (`open-take inspect <url>` lists one), or name a real control instead",
        });
        continue;
      }
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
