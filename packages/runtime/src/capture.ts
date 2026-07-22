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

// Find a clickable by accessible name (aria-label or text), record its
// rect (ground-truth bbox), and click it — all in one page eval so the
// bbox and the action refer to the same element. Robust where CSS hooks
// are unstable.
export function clickByTextJs(text: string): string {
  const t = JSON.stringify(text);
  return (
    `(function(){var t=${t};` +
    `var els=Array.prototype.slice.call(document.querySelectorAll('button,a,[role=button],[role=link],[role=menuitem],input[type=submit],input[type=button]'));` +
    `function name(e){return (e.getAttribute('aria-label')||e.textContent||'').replace(/\\s+/g,' ').trim();}` +
    `var m=els.filter(function(e){return name(e)===t;})[0]||els.filter(function(e){return name(e).indexOf(t)!==-1;})[0];` +
    `if(!m)return 'NOTFOUND';` +
    // m.click() fires programmatically and never scrolls; below-fold targets
    // would advance state off-screen. Scroll into view ONLY when out of frame
    // so in-view beats keep their framing; re-read the rect post-scroll so the
    // compositor gets a viewport-relative (in-frame) bbox.
    `var r=m.getBoundingClientRect();` +
    `if(r.top<0||r.bottom>window.innerHeight){m.scrollIntoView({block:'center'});r=m.getBoundingClientRect();}` +
    `var b={x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)};` +
    `m.click();return JSON.stringify(b);})()`
  );
}

// Selector twin of clickByTextJs: resolve the element's rect AND click it in
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
    `var r=m.getBoundingClientRect();` +
    `if(r.top<0||r.bottom>window.innerHeight){m.scrollIntoView({block:'center'});r=m.getBoundingClientRect();}` +
    `var b={x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)};` +
    `m.click();return JSON.stringify(b);})()`
  );
}

// --- type/drag resolvers ------------------------------------------------
// type targets are form fields (input/textarea/contenteditable), which the
// clickable locator above does NOT match. Resolve the field by accessible
// name OR placeholder, scroll into view, focus + click (caret), return bbox.
export function focusFieldByTextJs(text: string): string {
  const t = JSON.stringify(text);
  return (
    `(function(){var t=${t};` +
    `var els=Array.prototype.slice.call(document.querySelectorAll('input,textarea,[contenteditable],[contenteditable=true],[role=textbox],[role=searchbox]'));` +
    `function name(e){return (e.getAttribute('aria-label')||e.getAttribute('placeholder')||e.textContent||'').replace(/\\s+/g,' ').trim();}` +
    `var m=els.filter(function(e){return name(e)===t;})[0]||els.filter(function(e){return name(e).indexOf(t)!==-1;})[0];` +
    `if(!m)return 'NOTFOUND';` +
    `var r=m.getBoundingClientRect();` +
    `if(r.top<0||r.bottom>window.innerHeight){m.scrollIntoView({block:'center'});r=m.getBoundingClientRect();}` +
    `var b={x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)};` +
    `m.focus();m.click();m.focus();return JSON.stringify(b);})()`
  );
}

export function focusSelectorJs(selector: string): string {
  const s = JSON.stringify(selector);
  return (
    `(function(){var m=document.querySelector(${s});if(!m)return 'NOTFOUND';` +
    `var r=m.getBoundingClientRect();` +
    `if(r.top<0||r.bottom>window.innerHeight){m.scrollIntoView({block:'center'});r=m.getBoundingClientRect();}` +
    `var b={x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)};` +
    `m.focus();m.click();m.focus();return JSON.stringify(b);})()`
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
    `var els=Array.prototype.slice.call(document.querySelectorAll('button,a,[role=button],[role=link],[role=menuitem],[aria-label],[title],img[alt],li,[draggable=true]'));` +
    `function name(e){return (e.getAttribute('aria-label')||e.getAttribute('title')||e.getAttribute('alt')||e.textContent||'').replace(/\\s+/g,' ').trim();}` +
    `var m=els.filter(function(e){return name(e)===t;})[0]||els.filter(function(e){return name(e).indexOf(t)!==-1;})[0];` +
    `if(!m)return 'NOTFOUND';var r=m.getBoundingClientRect();` +
    `if(r.top<0||r.bottom>window.innerHeight){m.scrollIntoView({block:'center'});r=m.getBoundingClientRect();}` +
    `return JSON.stringify({x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)});})()`
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
    `var els=Array.prototype.slice.call(document.querySelectorAll('button,a,[role=button],[role=link],[role=heading],[aria-label],[title],h1,h2,h3,li,section,p'));` +
    `function name(e){return (e.getAttribute('aria-label')||e.getAttribute('title')||e.textContent||'').replace(/\\s+/g,' ').trim();}` +
    `var m=els.filter(function(e){return name(e)===t;})[0]||els.filter(function(e){return name(e).indexOf(t)!==-1;})[0];` +
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
    c.stdout.on("data", (d) => (out += d));
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
   * Capture + encode fps. Default 60 (the polished, premium 60fps feel).
   * Capture is a CDP screencast at the browser's
   * native rate; this is the encode grid and the intended render fps. Drop to
   * 30 for fast-draft renders (~½ the render time + file size) while iterating.
   * See cdp-capture.ts.
   */
  fps?: number;
  /** explicit Chrome binary (else auto-resolved system Chrome / auto-download) */
  chromePath?: string;
  /** How a `drag` stroke is paced (and thus baked into the ink): "smooth"
   *  (accel-in / decel-out — a natural hand-draw, default) or "linear"
   *  (constant speed). Recorded on each drag event so the compositor cursor
   *  replays the same easing and stays locked to the ink. */
  dragEasing?: "linear" | "smooth";
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
  viewport: { w: number; h: number };
  elements: InspectElement[];
};

function listInteractiveJs(): string {
  return (
    `(function(){` +
    `function nm(e){return (e.getAttribute('aria-label')||e.textContent||'').replace(/\\s+/g,' ').trim();}` +
    `var sel='button,a,[role=button],[role=link],[role=menuitem],[role=tab],[role=switch],[role=checkbox],input,select,textarea';` +
    `var els=Array.prototype.slice.call(document.querySelectorAll(sel));var vw=window.innerWidth,vh=window.innerHeight;var out=[];var seen={};` +
    `for(var i=0;i<els.length;i++){var e=els[i];var n=nm(e);var ph=e.getAttribute('placeholder');var r=e.getBoundingClientRect();` +
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
};

/** Open `url`, return its interactive elements (accessible name + bbox) —
 *  what an agent uses to choose a demo flow. Pure CDP, same as capture, so
 *  the reported coordinate space matches what capture will drive against. */
export async function inspectPage(url: string, opts: InspectOpts = {}): Promise<InspectResult> {
  const vw = opts.viewport?.width ?? 1920;
  const vh = opts.viewport?.height ?? 1080;
  const browser = await launchBrowser({ width: vw, height: vh, chromePath: opts.chromePath });
  try {
    const { cdp } = browser;
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    const inner = await fitViewport(cdp, browser.targetId, vw, vh);
    await cdp.send("Page.navigate", { url });
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

    return { url, viewport: { w: inner[0], h: inner[1] }, elements };
  } finally {
    await browser.close();
  }
}
