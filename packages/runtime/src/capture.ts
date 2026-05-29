// captureTake: drive the real app via agent-browser and emit the
// ground-truth event log (exact `get box` coords + measured timings) +
// a webm. This timing is why the compositor never has to *infer* zoom
// intent — the moat. (The harvested AgentBrowserDriver coalesces a step
// into one batch with no per-action timing; polish capture needs the
// sequential, timestamped path, so we drive the CLI directly here.)

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { CaptureLog } from "@open-take/compositor";
import type { TakePlan } from "./types";

function resolveBin(): string {
  const local = resolve(process.cwd(), "node_modules/.bin/agent-browser");
  return existsSync(local) ? local : "agent-browser";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function ab(bin: string, session: string, args: string[]): Promise<string> {
  return new Promise((res, rej) => {
    const child = spawn(bin, ["--session-name", session, ...args, "--json"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", rej);
    child.on("close", (code) =>
      code !== 0 && out.length === 0 ? rej(new Error(`agent-browser ${args[0]} exited ${code}: ${err}`)) : res(out.trim()),
    );
  });
}

type Box = { x: number; y: number; w: number; h: number };

function findBox(o: unknown): Box | null {
  if (!o || typeof o !== "object") return null;
  const r = o as Record<string, unknown>;
  if (typeof r.x === "number" && typeof r.y === "number" && (typeof r.width === "number" || typeof r.w === "number"))
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
function evalValue(raw: string): unknown {
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

const boxFromEval = (raw: string): Box | null => findBox(evalValue(raw));

// Find a clickable by accessible name (aria-label or text), record its
// rect (ground-truth bbox), and click it — all in one page eval so the
// bbox and the action refer to the same element. Robust where CSS hooks
// are unstable.
function clickByTextJs(text: string): string {
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
function clickBySelectorJs(selector: string): string {
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

function ffprobe(path: string): Promise<{ width?: number; height?: number; fps?: string; durationS?: number }> {
  return new Promise((res) => {
    const c = spawn("ffprobe", [
      "-v", "error", "-select_streams", "v:0",
      "-show_entries", "stream=width,height,r_frame_rate,duration",
      "-show_entries", "format=duration", "-of", "json", path,
    ], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    c.stdout.on("data", (d) => (out += d));
    c.on("close", () => {
      try {
        const j = JSON.parse(out);
        const s = j.streams?.[0] ?? {};
        res({ width: s.width, height: s.height, fps: s.r_frame_rate, durationS: Number(s.duration ?? j.format?.duration ?? 0) });
      } catch {
        res({});
      }
    });
  });
}

export type CaptureOpts = {
  /** webm output path */
  videoPath: string;
  /** agent-browser session name */
  session?: string;
  /** ms to let the page settle after record start before the first action */
  warmupMs?: number;
  binPath?: string;
};

/** Drive `plan` against the live app, return the ground-truth event log. */
export async function captureTake(plan: TakePlan, opts: CaptureOpts): Promise<CaptureLog> {
  const bin = opts.binPath ?? resolveBin();
  const session = opts.session ?? `open-take-${Math.random().toString(36).slice(2, 10)}`;
  const vw = plan.viewport?.width ?? 1920;
  const vh = plan.viewport?.height ?? 1080;
  const webm = resolve(opts.videoPath);
  await mkdir(dirname(webm), { recursive: true });

  await ab(bin, session, ["set", "viewport", String(vw), String(vh)]);
  await ab(bin, session, ["open", plan.url]);
  await sleep(400);
  await ab(bin, session, ["record", "start", webm, plan.url]);
  const t0 = Date.now();
  await sleep(opts.warmupMs ?? 900);

  // authoritative coordinate space = the recording page's CSS viewport
  let inner: [number, number] = [vw, vh];
  try {
    const arr = evalValue(await ab(bin, session, ["eval", "JSON.stringify([window.innerWidth, window.innerHeight])"]));
    if (Array.isArray(arr) && arr.length === 2) inner = [Number(arr[0]), Number(arr[1])];
  } catch {
    /* fall back to requested viewport */
  }

  const clicks: CaptureLog["clicks"] = [];
  for (const step of plan.steps) {
    if (step.action === "wait") {
      await sleep(step.ms);
      continue;
    }
    // click: capture timestamp, resolve bbox (ground truth), click
    const label = step.text ?? step.selector;
    const tMs = Date.now() - t0;
    let box: Box | null = null;
    if (step.text) {
      box = boxFromEval(await ab(bin, session, ["eval", clickByTextJs(step.text)]));
    } else if (step.selector) {
      box = boxFromEval(await ab(bin, session, ["eval", clickBySelectorJs(step.selector)]));
    }
    if (box) {
      clicks.push({
        x: Math.round(box.x + box.w / 2),
        y: Math.round(box.y + box.h / 2),
        box,
        tMs,
        sel: label,
        note: step.note,
        ...(step.zoom ? { zoom: step.zoom } : {}),
      });
    } else {
      // a silently-dropped target would lose a demo beat — surface it
      console.error(`captureTake: target not found, skipped: ${JSON.stringify(label)}`);
    }
    await sleep(step.settleMs ?? 1300);
  }

  const tEndMs = Date.now() - t0;
  await sleep(400);
  await ab(bin, session, ["record", "stop"]);
  await ab(bin, session, ["close"]).catch(() => {});

  const probe = await ffprobe(webm);
  return {
    video: { width: probe.width ?? inner[0], height: probe.height ?? inner[1], fps: probe.fps, durationS: probe.durationS },
    viewport: { w: inner[0], h: inner[1] },
    start: plan.startCursor ?? { x: Math.round(inner[0] * 0.25), y: Math.round(inner[1] * 0.9) },
    clicks,
    tEndMs,
  };
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
  session?: string;
  warmupMs?: number;
  binPath?: string;
};

/** Open `url`, return its interactive elements (accessible name + bbox) —
 *  what an agent uses to choose a demo flow. */
export async function inspectPage(url: string, opts: InspectOpts = {}): Promise<InspectResult> {
  const bin = opts.binPath ?? resolveBin();
  const session = opts.session ?? `open-take-inspect-${Math.random().toString(36).slice(2, 10)}`;
  const vw = opts.viewport?.width ?? 1920;
  const vh = opts.viewport?.height ?? 1080;

  await ab(bin, session, ["set", "viewport", String(vw), String(vh)]);
  await ab(bin, session, ["open", url]);
  await sleep(opts.warmupMs ?? 1500);

  let inner: [number, number] = [vw, vh];
  try {
    const arr = evalValue(await ab(bin, session, ["eval", "JSON.stringify([window.innerWidth, window.innerHeight])"]));
    if (Array.isArray(arr) && arr.length === 2) inner = [Number(arr[0]), Number(arr[1])];
  } catch {
    /* fall back */
  }

  let elements: InspectElement[] = [];
  try {
    const v = evalValue(await ab(bin, session, ["eval", listInteractiveJs()]));
    if (Array.isArray(v)) elements = v as InspectElement[];
  } catch {
    /* leave empty */
  }

  await ab(bin, session, ["close"]).catch(() => {});
  return { url, viewport: { w: inner[0], h: inner[1] }, elements };
}
