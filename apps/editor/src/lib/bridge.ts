// Client for the local edit-server (open-take edit). When the editor is served
// by the bridge, GET /api/take succeeds and we run in "bridge mode": auto-load
// the take, Save persists composition.json, Export triggers a real revideo
// render with live progress. Served as a plain Vite SPA (pnpm dev) the calls
// just fail → the app stays in sample/drop mode and Export degrades to download.

import type { CaptureLog, CompositionIssue, TakeComposition } from "./compositor";

export type BridgeTake = {
  composition: TakeComposition;
  captureLog: CaptureLog | null;
  source: { name: string };
  videoUrl: string;
  mp4Url: string;
};

export class BridgeError extends Error {
  issues?: CompositionIssue[];
  constructor(message: string, issues?: CompositionIssue[]) {
    super(message);
    this.name = "BridgeError";
    this.issues = issues;
  }
}

/** Probe the bridge. Returns the take payload, or null when not behind it. */
export async function detectBridge(): Promise<BridgeTake | null> {
  try {
    const r = await fetch("/api/take");
    if (!r.ok) return null;
    return (await r.json()) as BridgeTake;
  } catch {
    return null;
  }
}

/** Persist composition.json without rendering. Throws BridgeError(issues) on 400. */
export async function saveComposition(comp: TakeComposition): Promise<void> {
  const r = await fetch("/api/composition", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(comp),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new BridgeError(data.error ?? "save rejected", data.issues);
}

/** Kick off a render and resolve when the mp4 is written, streaming progress. */
export async function renderViaBridge(
  comp: TakeComposition,
  onProgress: (p: number) => void,
): Promise<{ mp4Url: string }> {
  const r = await fetch("/api/render", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(comp),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new BridgeError(data.error ?? "render rejected", data.issues);
  const jobId = data.jobId as string;

  return new Promise((resolve, reject) => {
    const es = new EventSource(`/api/render/${jobId}/events`);
    let settled = false;
    es.addEventListener("progress", (e) =>
      onProgress(JSON.parse((e as MessageEvent).data).progress as number),
    );
    es.addEventListener("done", (e) => {
      settled = true;
      es.close();
      resolve({ mp4Url: JSON.parse((e as MessageEvent).data).mp4Url as string });
    });
    es.addEventListener("failed", (e) => {
      settled = true;
      es.close();
      reject(new Error(JSON.parse((e as MessageEvent).data).message as string));
    });
    es.onerror = () => {
      if (settled) return;
      es.close();
      reject(new Error("lost connection to the render stream"));
    };
  });
}
