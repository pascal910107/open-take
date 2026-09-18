// captureTake / inspectPage — drive the real app over the Chrome DevTools
// Protocol (pure CDP — no agent-browser) and emit the ground-truth event log.
// The exact bbox coords + measured timings are why the compositor never has
// to *infer* zoom intent — the moat. All driving + recording lives in
// cdp-capture.ts (captureTakeCDP); this module owns the element-locator JS
// (shared by both paths) + the planning aid, and captureTake just delegates.

import { spawn } from "node:child_process";
import { type CaptureLog, resolveFfprobe } from "@open-take/compositor";
import { fitViewport, launchBrowser } from "./cdp";
import type { TakePlan } from "./types";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type Box = { x: number; y: number; w: number; h: number };

// Recursively find a {x,y,w/width,h/height} rect in a parsed value. Exported
// so the CDP capture path can robustly extract a bbox from any eval shape.
export function findBox(o: unknown): Box | null {
  if (!o || typeof o !== "object") return null;
  const r = o as Record<string, unknown>;
  if (
    typeof r.x === "number" &&
    typeof r.y === "number" &&
    (typeof r.width === "number" || typeof r.w === "number")
  )
    return { x: r.x, y: r.y, w: (r.width ?? r.w) as number, h: (r.height ?? r.h) as number };
  for (const k of Object.keys(r)) {
    const hit = findBox(r[k]);
    if (hit) return hit;
  }
  return null;
}

// Repeatedly JSON.parse while the value is still a string (handles double-
// encoding).
function deepParse(s: unknown): unknown {
  let cur = s;
  for (let i = 0; i < 5 && typeof cur === "string"; i++) {
    try {
      cur = JSON.parse(cur as string);
    } catch {
      break;
    }
  }
  return cur;
}

// Extract the actual returned value from agent-browser --json output.
// eval:    {"success":true,"data":{"result":"<encoded>"},"error":null}
// get box: similar wrapper around the box. Falls back to deep-parsing raw.
export function evalValue(raw: string): unknown {
  let top: unknown;
  try {
    top = JSON.parse(raw);
  } catch {
    return deepParse(raw);
  }
  if (top && typeof top === "object") {
    const o = top as Record<string, unknown>;
    const data = o.data as Record<string, unknown> | undefined;
    if (data && "result" in data) return deepParse(data.result);
    for (const k of ["result", "output", "stdout", "value"]) if (k in o) return deepParse(o[k]);
  }
  return deepParse(top);
}

// --- one name resolver for every text locator ---------------------------
// Each locator below used to carry its OWN precedence chain, and they
// disagreed: `click` matched `aria-label || textContent`, while `drag` /
// `press` / `scroll` / `hrefFrom` put `title` FIRST, and `inspect` — the
// planning aid whose output SKILL.md explicitly tells agents to "target these
// by `text`" — used a third chain. So an element with a visible label AND a
// tooltip was advertised by `inspect` under its label, clicked fine, and then
// silently failed to resolve for a drag. The editor's own Compare button is a
// live example: label "Compare", title "Hold to compare against the version
// you opened" — `text: "Compare"` resolved for a click and NOTFOUND for a drag.
// Title-only controls (icon buttons, the editor's Look swatches) were worse:
// `inspect` skipped them entirely, so nothing advertised them at all.
//
// Now every locator matches against ALL of an element's names — exact before
// substring, DOM order. This is strictly more permissive than any of the old
// chains, so nothing that resolved before stops resolving, and an exact hit
// anywhere in the document still beats a substring hit that comes earlier.
export const NAME_JS =
  `function names(e){var raw=[e.getAttribute('aria-label'),e.textContent,e.getAttribute('title'),e.getAttribute('alt'),e.getAttribute('placeholder')];var out=[];` +
  `for(var i=0;i<raw.length;i++){var s=(raw[i]||'').replace(/\\s+/g,' ').trim();if(s&&out.indexOf(s)===-1)out.push(s);}return out;}` +
  // The name to SHOW (inspect). Placeholder is deliberately NOT a display name:
  // inspect renders a placeholder-only field as "[placeholder]" so a plan
  // author can see at a glance that the control has no real label.
  `function dispName(e){var a=[e.getAttribute('aria-label'),e.textContent,e.getAttribute('title'),e.getAttribute('alt')];` +
  `for(var i=0;i<a.length;i++){var s=(a[i]||'').replace(/\\s+/g,' ').trim();if(s)return s;}return '';}` +
  `function pick(els,t){var i,n,j;` +
  `for(i=0;i<els.length;i++){if(names(els[i]).indexOf(t)!==-1)return els[i];}` +
  `for(i=0;i<els.length;i++){n=names(els[i]);for(j=0;j<n.length;j++){if(n[j].indexOf(t)!==-1)return els[i];}}` +
  `return null;}`;

// Shared tail for both click resolvers: the element is in hand — decide HOW
// the click gets delivered. `m.click()` fires a lone synthetic `click` event
// with NO pointerdown/mousedown/pointerup in front of it, and a whole class
// of real controls listens to exactly those: a Radix DropdownMenuTrigger
// opens on pointerdown, so a programmatic click was a SILENT no-op — the
// step "succeeded", nothing opened, and every later beat died with "target
// not found" (a measured shoot lost 8 of 10 beats this way). So when the
// element's centre is actually hittable — elementFromPoint lands on it or on
// one of its descendants — do NOT click in-page: return the point (`cx`/`cy`)
// and let the capture driver deliver a trusted CDP press/release there, the
// full native pipeline `hover` and `drag` already use. The in-page m.click()
// survives as the fallback for what a coordinate cannot reach: zero-size
// targets (sr-only), a centre covered by an unrelated overlay,
// pointer-events:none — everything that resolved before still resolves.
//
// Scrolling: m.click() never scrolls, and a below-fold target would advance
// state off-screen — so scroll into view ONLY when out of frame (in-view
// beats keep their framing) and re-read the rect so the compositor gets a
// viewport-relative bbox. behavior:'instant' is load-bearing for the point
// path: with CSS scroll-behavior:smooth the post-scroll rect is mid-animation
// and the trusted click would land on yesterday's layout.
//
// The hittable test asks BOTH point APIs before giving up on the point path.
// Chrome's singular elementFromPoint can return an element whose border box
// does not even contain the point: measured on a 33px-tall heading whose
// centre sat 16px above a sibling with 164px glyphs on a 157px line-height —
// the sibling's ink overflow won the singular hit-test at every sample while
// elementsFromPoint()[0] (per spec, the same answer) named the heading, and a
// trusted click at that point reached the heading. Treating the singular miss
// as an occluder silently downgraded the beat to m.click() — which the app
// ignored, because its edit-mode handler resolves the anchor from the click's
// clientX/clientY and a programmatic click carries (0,0). The beat died with
// changeCoverage 0 and every dependent beat skipped. So: a miss from the
// singular API alone is not occlusion — only when the layered list agrees the
// centre belongs to someone else does the in-page fallback fire.
const HITTABLE_JS =
  `function hittable(m,r){var cx=Math.round(r.x+r.width/2),cy=Math.round(r.y+r.height/2);` +
  `if(!(r.width>0&&r.height>0&&document.elementFromPoint))return null;` +
  `var hit=document.elementFromPoint(cx,cy);` +
  `var ok=!!hit&&(hit===m||(m.contains&&m.contains(hit)));` +
  `if(!ok&&document.elementsFromPoint){var top=document.elementsFromPoint(cx,cy)[0];` +
  `ok=!!top&&(top===m||(m.contains&&m.contains(top)));}` +
  `return ok?{cx:cx,cy:cy}:null;}`;

const CLICK_TAIL_JS =
  `if(m.tagName==='SELECT')return 'SELECTINERT';` +
  HITTABLE_JS +
  `var r=m.getBoundingClientRect();` +
  `if(r.top<0||r.bottom>window.innerHeight){m.scrollIntoView({block:'center',behavior:'instant'});r=m.getBoundingClientRect();}` +
  `var b={x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)};` +
  `var p=hittable(m,r);` +
  `if(p){b.cx=p.cx;b.cy=p.cy;return JSON.stringify(b);}` +
  `m.click();return JSON.stringify(b);`;

// The candidate sets each by-text locator queries — exported for the
// pre-capture check (precheck.ts), which must resolve with EXACTLY these:
// a looser probe set would pass targets the real locator then misses, a
// tighter one would refuse targets it finds.
export const CLICK_CANDIDATES =
  "button,a,[role=button],[role=link],[role=menuitem],input[type=submit],input[type=button]";
export const FIELD_CANDIDATES =
  "input,textarea,[contenteditable],[contenteditable=true],[role=textbox],[role=searchbox]";
export const BOX_CANDIDATES =
  "button,a,[role=button],[role=link],[role=menuitem],[aria-label],[title],img[alt],li,[draggable=true]";
export const SCROLL_CANDIDATES =
  "button,a,[role=button],[role=link],[role=heading],[aria-label],[title],h1,h2,h3,li,section,p";

// Find a clickable by accessible name (aria-label or text), record its
// rect (ground-truth bbox), and resolve the click — all in one page eval so
// the bbox and the action refer to the same element. Robust where CSS hooks
// are unstable. Returns the bbox, plus `cx`/`cy` when the caller should
// deliver the click as trusted CDP input (see CLICK_TAIL_JS).
export function clickByTextJs(text: string): string {
  const t = JSON.stringify(text);
  return (
    `(function(){var t=${t};` +
    `var els=Array.prototype.slice.call(document.querySelectorAll('${CLICK_CANDIDATES}'));` +
    NAME_JS +
    `var m=pick(els,t);` +
    `if(!m)return 'NOTFOUND';` +
    CLICK_TAIL_JS +
    `})()`
  );
}

// Selector twin of clickByTextJs: resolve the element's rect AND the click in
// ONE page eval, atomically. The old path made two separate agent-browser
// round-trips (`get box <sel>` then `click <sel>`); under recording the CDP
// `get box` call flaked (returned null ~1-in-3) and the beat was silently
// skipped, gutting the demo. A single eval — the same mechanism the text
// path already uses reliably — removes that race.
export function clickBySelectorJs(selector: string): string {
  const s = JSON.stringify(selector);
  return (
    `(function(){var m=document.querySelector(${s});` +
    `if(!m)return 'NOTFOUND';` +
    CLICK_TAIL_JS +
    `})()`
  );
}

// --- type/drag resolvers ------------------------------------------------
// type targets are form fields (input/textarea/contenteditable), which the
// clickable locator above does NOT match. Resolve the field by accessible
// name OR placeholder, scroll into view, focus + click (caret), return bbox.
//
// Whether focus actually LANDED rides back as `f` — Input.insertText types
// into the current selection, so when the in-page focus();click();focus()
// bounces off (a contenteditable that only arms when the app sees a real
// click's coordinates: measured, activeElement stayed BODY and the whole
// string went nowhere while the step logged as a success), the driver must
// know, not guess.
//
// The predicate reads the DEEP active element (piercing shadow roots — a web
// component reports its host as document.activeElement while insertText lands
// in the shadow's own active element) and calls it focused when it can take
// an insertion (isContentEditable, or a string .value that is not readOnly/
// disabled — a readOnly field swallows insertText exactly like body does)
// AND it belongs to the target: on the composed ancestry (host chain
// included), or as an editable host wrapping the target. document.body only
// counts when body itself IS the target (designMode pages).
const FOCUS_STATE_JS =
  `function deepActive(){var a=document.activeElement;` +
  `while(a&&a.shadowRoot&&a.shadowRoot.activeElement){a=a.shadowRoot.activeElement;}return a;}` +
  `function editable(a){if(!a)return false;if(a.isContentEditable)return true;` +
  `return typeof a.value==='string'&&!a.readOnly&&!a.disabled;}` +
  `function withinTarget(a){var n=a;while(n){if(n===m||(m.contains&&m.contains(n)))return true;` +
  `var rn=n.getRootNode?n.getRootNode():null;n=n.parentElement||((rn&&rn.host)?rn.host:null);}return false;}` +
  `var ae=deepActive();` +
  `var ok=!!ae&&(ae!==document.body||m===document.body)&&editable(ae)&&` +
  `(withinTarget(ae)||(ae.isContentEditable&&ae.contains&&ae.contains(m)));`;

// behavior:'instant' is load-bearing here too now: the box this returns aims
// the driver's trusted recovery click, and a smooth scroll mid-flight would
// hand it yesterday's layout (same reasoning as CLICK_TAIL_JS). When focus
// bounced, `hit` says whether that recovery click can even reach the field —
// the same hittable test the click path runs, read AFTER the in-page
// focus/click so it sees whatever those opened. A covered centre is reported
// rather than punched: a trusted press through an overlay would land on the
// overlay as a real click, mutate state on camera, and the beat would still
// skip.
const FOCUS_TAIL_JS =
  HITTABLE_JS +
  `var r=m.getBoundingClientRect();` +
  `if(r.top<0||r.bottom>window.innerHeight){m.scrollIntoView({block:'center',behavior:'instant'});r=m.getBoundingClientRect();}` +
  `var b={x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)};` +
  `m.focus();m.click();m.focus();` +
  FOCUS_STATE_JS +
  `b.f=ok?1:0;` +
  `if(!ok){b.hit=hittable(m,m.getBoundingClientRect())?1:0;}` +
  `return JSON.stringify(b);`;

export function focusFieldByTextJs(text: string): string {
  const t = JSON.stringify(text);
  return (
    `(function(){var t=${t};` +
    `var els=Array.prototype.slice.call(document.querySelectorAll('${FIELD_CANDIDATES}'));` +
    NAME_JS +
    `var m=pick(els,t);` +
    `if(!m)return 'NOTFOUND';` +
    FOCUS_TAIL_JS +
    `})()`
  );
}

export function focusSelectorJs(selector: string): string {
  const s = JSON.stringify(selector);
  return (
    `(function(){var m=document.querySelector(${s});if(!m)return 'NOTFOUND';` +
    FOCUS_TAIL_JS +
    `})()`
  );
}

// Side-effect-free re-check of the focus predicate, for after the driver has
// delivered a trusted click at the field's centre (the recovery a real user
// performs by hand). Resolves the target exactly like the focus builders but
// never focuses or clicks — a second in-page click here could toggle app
// state the first one already changed.
//
// After that REAL click the ownership test widens: some editors focus a
// proxy editable OUTSIDE the clicked container (hidden textarea patterns), so
// post-click, a deep active element that can take the insertion is accepted
// wherever it lives — that is where a real user's click-then-type would land,
// and the strict tier already handled the no-click case. What still skips:
// focus parked on body or a non-editable control (the measured lie).
export function verifyFocusJs(target: { text?: string; selector?: string }): string {
  if (!target.text && !target.selector) return `'0'`;
  const resolve = target.text
    ? `var els=Array.prototype.slice.call(document.querySelectorAll('${FIELD_CANDIDATES}'));` +
      NAME_JS +
      `var m=pick(els,${JSON.stringify(target.text)});`
    : `var m=document.querySelector(${JSON.stringify(target.selector ?? "")});`;
  return (
    `(function(){${resolve}if(!m)return '0';` +
    FOCUS_STATE_JS +
    `if(ok)return '1';` +
    `return (!!ae&&ae!==document.body&&editable(ae))?'1':'0';})()`
  );
}

// Select the focused element's ENTIRE current value (input/textarea via
// select(); contenteditable via a DOM range) so the next Input.insertText
// REPLACES it — the `type` step's `clear: true`. Chrome's editing commands
// don't run off dispatched key events (a "Meta+a" press registers nothing),
// so the selection is made in-page instead.
export function selectAllInFocusedJs(): string {
  return (
    `(function(){var el=document.activeElement;if(!el)return 'NOFOCUS';` +
    `if(typeof el.select==='function'&&typeof el.value==='string'){el.select();return 'SEL';}` +
    `if(el.isContentEditable){var r=document.createRange();r.selectNodeContents(el);` +
    `var s=window.getSelection();s.removeAllRanges();s.addRange(r);return 'SEL';}` +
    `return 'NOSEL';})()`
  );
}

// bbox-only resolvers for drag endpoints — never click/focus (a drag must
// not deselect a tool or shift the canvas before the stroke).
export function boxSelectorJs(selector: string): string {
  const s = JSON.stringify(selector);
  return (
    `(function(){var m=document.querySelector(${s});if(!m)return 'NOTFOUND';` +
    `var r=m.getBoundingClientRect();` +
    `if(r.top<0||r.bottom>window.innerHeight){m.scrollIntoView({block:'center'});r=m.getBoundingClientRect();}` +
    `return JSON.stringify({x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)});})()`
  );
}

export function boxByTextJs(text: string): string {
  const t = JSON.stringify(text);
  return (
    `(function(){var t=${t};` +
    `var els=Array.prototype.slice.call(document.querySelectorAll('${BOX_CANDIDATES}'));` +
    NAME_JS +
    `var m=pick(els,t);` +
    `if(!m)return 'NOTFOUND';var r=m.getBoundingClientRect();` +
    `if(r.top<0||r.bottom>window.innerHeight){m.scrollIntoView({block:'center'});r=m.getBoundingClientRect();}` +
    `return JSON.stringify({x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)});})()`
  );
}

// --- href resolvers -----------------------------------------------------
// Read a link's DESTINATION without clicking it — the late-bound half of the
// `navigate` step. Returns the browser-resolved absolute URL (`.href`), never
// the raw attribute, so a relative or protocol-relative link comes back usable.
// Neither of these scrolls or clicks: nothing on screen may change, because
// this runs mid-recording and the beat is the navigation itself.
const CLOSEST_ANCHOR_JS =
  // The named element may BE the link or sit inside one — closest() covers both
  // (it tests the element itself first) — or WRAP one, which it does not.
  `var a=m.closest('a[href]')||m.querySelector('a[href]');` +
  `if(!a||!a.href)return 'NOTFOUND';return a.href;`;

export function hrefSelectorJs(selector: string): string {
  const s = JSON.stringify(selector);
  return `(function(){var m=document.querySelector(${s});if(!m)return 'NOTFOUND';${CLOSEST_ANCHOR_JS}})()`;
}

export function hrefByTextJs(text: string): string {
  const t = JSON.stringify(text);
  return (
    `(function(){var t=${t};` +
    `var els=Array.prototype.slice.call(document.querySelectorAll('a,button,[role=link],[role=button],[aria-label],[title]'));` +
    NAME_JS +
    `var m=pick(els,t);` +
    `if(!m)return 'NOTFOUND';${CLOSEST_ANCHOR_JS}})()`
  );
}

// --- scroll-to-element delta -------------------------------------------
// How far (signed px, + = down) to scroll so the element's centre lands at
// viewport centre. Measures the CURRENT rect WITHOUT scrollIntoView (a jump
// would defeat the smooth wheel ramp). Returns "NOTFOUND" or a {dy} JSON.
export function scrollDeltaSelectorJs(selector: string): string {
  const s = JSON.stringify(selector);
  return (
    `(function(){var m=document.querySelector(${s});if(!m)return 'NOTFOUND';` +
    `var r=m.getBoundingClientRect();` +
    `return JSON.stringify({dy:Math.round(r.top+r.height/2-window.innerHeight/2)});})()`
  );
}

export function scrollDeltaByTextJs(text: string): string {
  const t = JSON.stringify(text);
  return (
    `(function(){var t=${t};` +
    `var els=Array.prototype.slice.call(document.querySelectorAll('${SCROLL_CANDIDATES}'));` +
    NAME_JS +
    `var m=pick(els,t);` +
    `if(!m)return 'NOTFOUND';var r=m.getBoundingClientRect();` +
    `return JSON.stringify({dy:Math.round(r.top+r.height/2-window.innerHeight/2)});})()`
  );
}

// Sample a viewport-px point a fraction u (0..1) along a polyline by arc
// length — used to densify a drag into smooth mouse-move steps so canvas
// drawing libs receive continuous pointermove (and the stroke looks drawn).
export function sampleAlong(pts: { x: number; y: number }[], u: number): { x: number; y: number } {
  if (pts.length === 1) return pts[0]!;
  const seg: number[] = [];
  let total = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const d = Math.hypot(pts[i + 1]!.x - pts[i]!.x, pts[i + 1]!.y - pts[i]!.y);
    seg.push(d);
    total += d;
  }
  if (total === 0) return pts[0]!;
  let target = u * total;
  for (let i = 0; i < seg.length; i++) {
    if (target <= seg[i]! || i === seg.length - 1) {
      const f = seg[i]! > 0 ? target / seg[i]! : 0;
      return {
        x: pts[i]!.x + (pts[i + 1]!.x - pts[i]!.x) * f,
        y: pts[i]!.y + (pts[i + 1]!.y - pts[i]!.y) * f,
      };
    }
    target -= seg[i]!;
  }
  return pts[pts.length - 1]!;
}

export async function ffprobe(
  path: string,
): Promise<{ width?: number; height?: number; fps?: string; durationS?: number }> {
  // resolved binary (PATH or bundled installer); the probe itself stays
  // best-effort — a failed probe resolves {} (callers have fallbacks).
  const bin = await resolveFfprobe().catch(() => null);
  if (!bin) return {};
  return new Promise((res) => {
    const c = spawn(
      bin,
      [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=width,height,r_frame_rate,duration",
        "-show_entries",
        "format=duration",
        "-of",
        "json",
        path,
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    let out = "";
    c.stdout.on("data", (d) => {
      out += d;
    });
    c.on("close", () => {
      try {
        const j = JSON.parse(out);
        const s = j.streams?.[0] ?? {};
        res({
          width: s.width,
          height: s.height,
          fps: s.r_frame_rate,
          durationS: Number(s.duration ?? j.format?.duration ?? 0),
        });
      } catch {
        res({});
      }
    });
  });
}

export type CaptureOpts = {
  /** output video path (mp4) */
  videoPath: string;
  /** ms to let the page settle after capture start before the first action */
  warmupMs?: number;
  /**
   * Encode fps. Default 60; this does not guarantee 60 unique captured frames.
   * Capture is a CDP screencast at the browser's
   * native rate; this is the encode grid and the intended render fps. Drop to
   * 30 for fast-draft renders (~½ the render time + file size) while iterating.
   * See cdp-capture.ts.
   */
  fps?: number;
  /**
   * Capture pixel density (device scale factor). Default 2: record at Retina
   * density — 2 physical px per CSS px — so a camera zoom ≤2× always has
   * ≥1:1 source pixels per output pixel and stays sharp (matches how premium
   * screen recorders keep zooms crisp). Coordinates everywhere (events, log,
   * composition) stay in CSS px; only the video bitmap is denser. Drop to 1
   * if a heavy page can't hold the capture fps at 4K screencast.
   */
  captureScale?: number;
  /** Refresh idle raster surfaces with a bounded screenshot request (default
   * "idle"). Use "off" for verified self-animating pages when screenshot
   * refresh interferes with their native frame delivery. Inspect actual frames
   * and captureCadence for the chosen scale; neither mode guarantees smoothness. */
  rasterRefresh?: "idle" | "off";
  /** explicit Chrome binary (else auto-resolved system Chrome / auto-download) */
  chromePath?: string;
  /** How a `drag` stroke is paced (and thus baked into the ink): "smooth"
   *  (accel-in / decel-out — a natural hand-draw, default) or "linear"
   *  (constant speed). Recorded on each drag event so the compositor cursor
   *  replays the same easing and stays locked to the ink. */
  dragEasing?: "linear" | "smooth";
  /** Persistent Chrome profile dir (an authenticated capture — pair with
   *  `open-take auth`). Default: a throwaway temp profile, removed on close. */
  userDataDir?: string;
  /** false ⇒ drive a visible (headed) window instead of headless. The
   *  screencast records either way — the escape hatch for sites that gate on
   *  a real window. Default true. */
  headless?: boolean;
  /** Extra ms a beat's hold may spend waiting for the PAGE when `settleMs`
   *  expires while it is still working (network in flight, DOM mutating, a
   *  reveal animating). Never shortens a hold — see runtime/src/settle.ts.
   *  Default `DEFAULT_SETTLE_BUDGET_MS`; 0 restores the old fixed sleeps
   *  exactly. */
  settleBudgetMs?: number;
};

/** Drive `plan` against the live app over CDP, return the ground-truth log. */
export async function captureTake(plan: TakePlan, opts: CaptureOpts): Promise<CaptureLog> {
  const { captureTakeCDP } = await import("./cdp-capture");
  return captureTakeCDP(plan, { ...opts, fps: opts.fps ?? 60 });
}

// --- inspectPage: planning aid -----------------------------------------

export type InspectElement = {
  name: string;
  tag: string;
  role: string | null;
  href: string | null;
  inView: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
};

export type InspectResult = {
  url: string;
  /** where the navigation actually landed (redirects, SPA rewrites) */
  finalUrl: string;
  /** document.title — the one-call check that this is the app you think it is
   *  (a stale port number silently serves a different project's dev server) */
  title: string;
  viewport: { w: number; h: number };
  elements: InspectElement[];
};

// Exported for the locator-name tests: the bug this shares a resolver with
// lived in the emitted page-JS, so the test evaluates this string directly.
export function listInteractiveJs(): string {
  return (
    `(function(){` +
    NAME_JS +
    `var sel='button,a,[role=button],[role=link],[role=menuitem],[role=tab],[role=switch],[role=checkbox],input,select,textarea';` +
    `var els=Array.prototype.slice.call(document.querySelectorAll(sel));var vw=window.innerWidth,vh=window.innerHeight;var out=[];var seen={};` +
    `for(var i=0;i<els.length;i++){var e=els[i];var n=dispName(e);var ph=e.getAttribute('placeholder');var r=e.getBoundingClientRect();` +
    `if(r.width<6||r.height<6)continue;if(!n&&!ph)continue;` +
    `var label=n||('['+(ph||e.tagName.toLowerCase())+']');var key=label+'@'+Math.round(r.x)+','+Math.round(r.y);if(seen[key])continue;seen[key]=1;` +
    `var iv=r.top<vh&&r.bottom>0&&r.left<vw&&r.right>0;` +
    `out.push({name:label,tag:e.tagName.toLowerCase(),role:e.getAttribute('role')||null,href:e.getAttribute('href')||null,inView:iv,x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)});}` +
    `out.sort(function(a,b){return (b.inView?1:0)-(a.inView?1:0);});` +
    `return JSON.stringify(out.slice(0,60));})()`
  );
}

export type InspectOpts = {
  viewport?: { width: number; height: number };
  warmupMs?: number;
  /** explicit Chrome binary (else auto-resolved / auto-downloaded) */
  chromePath?: string;
  /** persistent Chrome profile dir (inspect an authenticated page) */
  userDataDir?: string;
  /** false ⇒ inspect via a visible (headed) window. Default true. */
  headless?: boolean;
};

/** Open `url`, return its interactive elements (accessible name + bbox) —
 *  what an agent uses to choose a demo flow. Pure CDP, same as capture, so
 *  the reported coordinate space matches what capture will drive against. */
export async function inspectPage(url: string, opts: InspectOpts = {}): Promise<InspectResult> {
  const vw = opts.viewport?.width ?? 1920;
  const vh = opts.viewport?.height ?? 1080;
  const browser = await launchBrowser({
    width: vw,
    height: vh,
    chromePath: opts.chromePath,
    ...(opts.userDataDir ? { userDataDir: opts.userDataDir } : {}),
    ...(opts.headless === false ? { headless: false } : {}),
  });
  try {
    const { cdp } = browser;
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    const inner = await fitViewport(cdp, browser.targetId, vw, vh);
    // errorText set ⇒ no server answered (refused/DNS/timeout) and the tab is
    // showing Chrome's own error page — inspecting ITS elements would send an
    // agent planning a demo of ERR_CONNECTION_REFUSED. An HTTP 404/500 has no
    // errorText: the app answered, inspect what it said.
    const nav = await cdp.send<{ errorText?: string }>("Page.navigate", { url });
    if (nav.errorText)
      throw new Error(
        `inspectPage: ${url} did not answer (${nav.errorText}) — is the app running?`,
      );
    await sleep(opts.warmupMs ?? 1500);

    const evalRaw = async (expr: string): Promise<string> => {
      const r = await cdp.send<{ result?: { value?: unknown } }>("Runtime.evaluate", {
        expression: expr,
        returnByValue: true,
      });
      return String(r.result?.value ?? "");
    };

    let elements: InspectElement[] = [];
    try {
      const v = evalValue(await evalRaw(listInteractiveJs()));
      if (Array.isArray(v)) elements = v as InspectElement[];
    } catch {
      /* leave empty */
    }
    const title = await evalRaw("document.title").catch(() => "");
    const finalUrl = (await evalRaw("location.href").catch(() => "")) || url;

    return { url, finalUrl, title, viewport: { w: inner[0], h: inner[1] }, elements };
  } finally {
    await browser.close();
  }
}

// --- native <select> ----------------------------------------------------
// A native `<select>` cannot be DRIVEN by clicking it. Measured directly
// (probe, 2026-08-09): `.click()` on a select returns in ~3ms and changes
// NOTHING — value stays put, no popup paints, the app receives no event.
// Headless Chrome has no browser-process popup to open, so the click is a
// silent no-op: the beat films a cursor landing on a control that does not
// respond, and any downstream "the app recomputed" payoff never happens.
// (An earlier note here blamed a capture hang on this click; a direct probe
// disproved that — the click is inert, not blocking.)
//
// So we drive it the way the PAGE experiences it: set `value` and dispatch
// input+change. Same honesty class as `type` (synthesized keystrokes) — the
// app really receives the event, really recomputes, and the select really
// shows its new value on camera. Only the OS popup is missing, and that was
// never filmable.
//
// The option is matched by exact value, then exact label, then a trimmed
// substring of the label — real option text carries thin spaces, units and
// parenthetical detail ("Large  (30 seats)") that an author will not
// reproduce character-perfect.
export function selectOptionJs(
  target: { selector?: string; text?: string },
  value: string,
): string {
  const sel = JSON.stringify(target.selector ?? "");
  const name = JSON.stringify(target.text ?? "");
  const v = JSON.stringify(value);
  return (
    `(function(){var s=${sel},n=${name},want=${v};` +
    `var m=null;` +
    `if(s){m=document.querySelector(s);}` +
    `else if(n){var els=Array.prototype.slice.call(document.querySelectorAll('select'));` +
    // by accessible name: aria-label, the label element pointing at it, or a
    // wrapping label's text
    `m=els.find(function(e){var a=(e.getAttribute('aria-label')||'').trim();if(a===n)return true;` +
    `var id=e.id;if(id){var l=document.querySelector('label[for="'+id+'"]');if(l&&(l.textContent||'').trim().indexOf(n)>=0)return true;}` +
    `var p=e.closest('label');if(p&&(p.textContent||'').trim().indexOf(n)>=0)return true;return false;})||null;}` +
    `if(!m)return 'NOTFOUND';` +
    `if(m.tagName!=='SELECT')return 'NOTASELECT';` +
    `var opts=Array.prototype.slice.call(m.options);` +
    `var norm=function(x){return (x||'').replace(/\\s+/g,'').trim();};` +
    `var o=opts.find(function(x){return x.value===want;})` +
    `||opts.find(function(x){return norm(x.textContent)===norm(want);})` +
    `||opts.find(function(x){return norm(x.textContent).indexOf(norm(want))>=0;});` +
    `if(!o)return 'NOOPTION';` +
    `var r=m.getBoundingClientRect();` +
    `if(r.top<0||r.bottom>window.innerHeight){m.scrollIntoView({block:'center'});r=m.getBoundingClientRect();}` +
    `m.focus();m.value=o.value;` +
    `m.dispatchEvent(new Event('input',{bubbles:true}));` +
    `m.dispatchEvent(new Event('change',{bubbles:true}));` +
    `var b={x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)};` +
    `return JSON.stringify(b);})()`
  );
}
