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

// Run a sequence of agent-browser commands in ONE process (stdin JSON),
// paced internally with `wait <ms>` entries. Spawning a process per mouse
// move (~200ms overhead each) made a 1.6s drag take ~9s; batching keeps the
// whole paced stroke inside a single invocation so wall-clock ≈ the budget.
function abBatch(bin: string, session: string, cmds: string[][]): Promise<string> {
  return new Promise((res, rej) => {
    const child = spawn(bin, ["--session-name", session, "batch", "--json"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", rej);
    child.on("close", (code) => (code !== 0 && out.length === 0 ? rej(new Error(`agent-browser batch exited ${code}: ${err}`)) : res(out.trim())));
    child.stdin.write(JSON.stringify(cmds));
    child.stdin.end();
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

// Pull the first and last numeric eval results out of a `batch --json` array
// (the page-clock markers bracketing a drag's real draw window). Returns null
// if the markers can't be read, so the caller falls back to wall-clock timing.
function batchEvalEnds(raw: string): { start: number; end: number } | null {
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr) || arr.length < 2) return null;
    const start = Number(evalValue(JSON.stringify(arr[0])));
    const end = Number(evalValue(JSON.stringify(arr[arr.length - 1])));
    return Number.isFinite(start) && Number.isFinite(end) && end > start ? { start, end } : null;
  } catch {
    return null;
  }
}

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

// --- type/drag resolvers ------------------------------------------------
// type targets are form fields (input/textarea/contenteditable), which the
// clickable locator above does NOT match. Resolve the field by accessible
// name OR placeholder, scroll into view, focus + click (caret), return bbox.
function focusFieldByTextJs(text: string): string {
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

function focusSelectorJs(selector: string): string {
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
function boxSelectorJs(selector: string): string {
  const s = JSON.stringify(selector);
  return (
    `(function(){var m=document.querySelector(${s});if(!m)return 'NOTFOUND';` +
    `var r=m.getBoundingClientRect();` +
    `if(r.top<0||r.bottom>window.innerHeight){m.scrollIntoView({block:'center'});r=m.getBoundingClientRect();}` +
    `return JSON.stringify({x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)});})()`
  );
}

function boxByTextJs(text: string): string {
  const t = JSON.stringify(text);
  return (
    `(function(){var t=${t};` +
    `var els=Array.prototype.slice.call(document.querySelectorAll('button,a,[role=button],[role=link],[role=menuitem],[aria-label],li,[draggable=true]'));` +
    `function name(e){return (e.getAttribute('aria-label')||e.textContent||'').replace(/\\s+/g,' ').trim();}` +
    `var m=els.filter(function(e){return name(e)===t;})[0]||els.filter(function(e){return name(e).indexOf(t)!==-1;})[0];` +
    `if(!m)return 'NOTFOUND';var r=m.getBoundingClientRect();` +
    `if(r.top<0||r.bottom>window.innerHeight){m.scrollIntoView({block:'center'});r=m.getBoundingClientRect();}` +
    `return JSON.stringify({x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)});})()`
  );
}

// Sample a viewport-px point a fraction u (0..1) along a polyline by arc
// length — used to densify a drag into smooth mouse-move steps so canvas
// drawing libs receive continuous pointermove (and the stroke looks drawn).
function sampleAlong(pts: { x: number; y: number }[], u: number): { x: number; y: number } {
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
      return { x: pts[i]!.x + (pts[i + 1]!.x - pts[i]!.x) * f, y: pts[i]!.y + (pts[i + 1]!.y - pts[i]!.y) * f };
    }
    target -= seg[i]!;
  }
  return pts[pts.length - 1]!;
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

  // Calibrate the page clock (performance.now) against our capture clock
  // (Date.now − t0). A drag's true on-screen window is measured in page time
  // (markers inside the batch), but the cursor timeline runs on the capture
  // clock — so map one to the other: captureMs(P) = P + pageOffset.
  let pageOffset = 0;
  let pageCalibrated = false;
  try {
    const w1 = Date.now();
    const p = Number(evalValue(await ab(bin, session, ["eval", "performance.now()"])));
    const w2 = Date.now();
    if (Number.isFinite(p)) {
      pageOffset = (w1 + w2) / 2 - t0 - p;
      pageCalibrated = true;
    }
  } catch {
    /* leave uncalibrated; drag falls back to wall-clock timing */
  }

  type Pt = { x: number; y: number };
  // Resolve a viewport-px point from an explicit point, a CSS selector, or
  // an accessible name (bbox centre). No click/focus — for drag endpoints.
  const resolvePoint = async (spec: { point?: Pt; selector?: string; text?: string }): Promise<Pt | null> => {
    if (spec.point) return { x: Math.round(spec.point.x), y: Math.round(spec.point.y) };
    if (spec.selector) {
      const b = boxFromEval(await ab(bin, session, ["eval", boxSelectorJs(spec.selector)]));
      return b ? { x: Math.round(b.x + b.w / 2), y: Math.round(b.y + b.h / 2) } : null;
    }
    if (spec.text) {
      const b = boxFromEval(await ab(bin, session, ["eval", boxByTextJs(spec.text)]));
      return b ? { x: Math.round(b.x + b.w / 2), y: Math.round(b.y + b.h / 2) } : null;
    }
    return null;
  };

  const events: CaptureLog["events"] = [];
  for (const step of plan.steps) {
    if (step.action === "wait") {
      await sleep(step.ms);
      continue;
    }

    if (step.action === "type") {
      // focus the field (ground-truth bbox), then type with real keystrokes
      const label = step.text ?? step.selector;
      const tMs = Date.now() - t0;
      let box: Box | null = null;
      if (step.text) box = boxFromEval(await ab(bin, session, ["eval", focusFieldByTextJs(step.text)]));
      else if (step.selector) box = boxFromEval(await ab(bin, session, ["eval", focusSelectorJs(step.selector)]));
      if (!box) {
        console.error(`captureTake: type target not found, skipped: ${JSON.stringify(label)}`);
        await sleep(step.settleMs ?? 600);
        continue;
      }
      // type char-by-char, paced via `wait`, so the recording shows the text
      // appear progressively (one `keyboard type` call is near-instant).
      const chars = [...step.value];
      const perChar = Math.min(60, Math.max(28, Math.round(1100 / Math.max(1, chars.length))));
      const typeCmds: string[][] = [];
      for (const ch of chars) {
        typeCmds.push(["keyboard", "type", ch]);
        typeCmds.push(["wait", String(perChar)]);
      }
      const tType = Date.now();
      await abBatch(bin, session, typeCmds);
      const durationMs = Date.now() - tType;
      events.push({
        kind: "type",
        x: Math.round(box.x + box.w / 2),
        y: Math.round(box.y + box.h / 2),
        box,
        tMs,
        sel: label,
        note: step.note,
        text: step.value,
        durationMs,
        ...(step.zoom ? { zoom: step.zoom } : {}),
      });
      await sleep(step.settleMs ?? 900);
      continue;
    }

    if (step.action === "drag") {
      const from = await resolvePoint({ point: step.from, selector: step.selector, text: step.text });
      const to = await resolvePoint({ point: step.to, selector: step.toSelector, text: step.toText });
      const label = step.note ?? step.text ?? step.selector;
      if (!from || !to) {
        console.error(`captureTake: drag endpoint not found, skipped: ${JSON.stringify(label)}`);
        await sleep(step.settleMs ?? 600);
        continue;
      }
      // the polyline the stroke follows (viewport px)
      const path: Pt[] = step.path?.length
        ? step.path.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) }))
        : [from, to];
      const target = step.durationMs ?? 1200;
      // densify into ~one move per 40ms so canvas libs see continuous motion;
      // all moves + `wait` pacing run in ONE batch (per-move process spawn was
      // ~200ms each → a 1.6s drag took ~9s).
      const n = Math.max(8, Math.round(target / 40));
      const perStep = Math.round(target / n);
      // Bracket the real press→release with page-clock markers. The batch's
      // WALL-clock includes agent-browser process startup + teardown (~hundreds
      // of ms) that isn't on screen — pacing the cursor by it desyncs it from
      // the drawn ink (the ink visibly leads). performance.now() at down/up
      // gives the true on-screen draw window instead.
      const dragCmds: string[][] = [
        ["mouse", "move", String(path[0]!.x), String(path[0]!.y)],
        ["mouse", "down"],
        ["eval", "performance.now()"],
      ];
      for (let k = 1; k <= n; k++) {
        const p = sampleAlong(path, k / n);
        dragCmds.push(["wait", String(perStep)]);
        dragCmds.push(["mouse", "move", String(Math.round(p.x)), String(Math.round(p.y))]);
      }
      dragCmds.push(["eval", "performance.now()"]);
      dragCmds.push(["mouse", "up"]);
      const tMsWall = Date.now() - t0;
      const tDrag = Date.now();
      const dragOut = await abBatch(bin, session, dragCmds);
      const wallDuration = Date.now() - tDrag;
      // prefer the page-clock window; fall back to wall-clock if markers fail
      const marks = pageCalibrated ? batchEvalEnds(dragOut) : null;
      const tMs = marks ? Math.round(marks.start + pageOffset) : tMsWall;
      const durationMs = marks ? Math.round(marks.end - marks.start) : wallDuration;
      events.push({
        kind: "drag",
        x: from.x,
        y: from.y,
        to,
        path,
        tMs,
        sel: label,
        note: step.note,
        durationMs,
        ...(step.zoom ? { zoom: step.zoom } : {}),
      });
      await sleep(step.settleMs ?? 1100);
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
      events.push({
        kind: "click",
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
    events,
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
