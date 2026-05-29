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

function parseBox(stdout: string): Box | null {
  let v: unknown;
  try {
    v = JSON.parse(stdout);
  } catch {
    return null;
  }
  const find = (o: unknown): Box | null => {
    if (!o || typeof o !== "object") return null;
    const r = o as Record<string, unknown>;
    if (typeof r.x === "number" && typeof r.y === "number" && (typeof r.width === "number" || typeof r.w === "number"))
      return { x: r.x, y: r.y, w: (r.width ?? r.w) as number, h: (r.height ?? r.h) as number };
    for (const k of Object.keys(r)) {
      const hit = find(r[k]);
      if (hit) return hit;
    }
    return null;
  };
  return find(v);
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
    const raw = await ab(bin, session, ["eval", "JSON.stringify([window.innerWidth, window.innerHeight])"]);
    const m = JSON.parse(raw);
    const arr = JSON.parse(typeof m === "string" ? m : (m.result ?? m.output ?? m.stdout ?? JSON.stringify(m)));
    if (Array.isArray(arr) && arr.length === 2) inner = [arr[0], arr[1]];
  } catch {
    /* fall back to requested viewport */
  }

  const clicks: CaptureLog["clicks"] = [];
  for (const step of plan.steps) {
    if (step.action === "wait") {
      await sleep(step.ms);
      continue;
    }
    // click: query bbox (ground truth), timestamp, then click
    const raw = await ab(bin, session, ["get", "box", step.selector]);
    const box = parseBox(raw);
    const tMs = Date.now() - t0;
    await ab(bin, session, ["click", step.selector]);
    if (box) {
      clicks.push({
        x: Math.round(box.x + box.w / 2),
        y: Math.round(box.y + box.h / 2),
        box,
        tMs,
        sel: step.selector,
        note: step.note,
      });
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
