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
  /** composition.json's mtime when the server read it — see baseMtime below. */
  mtime?: number;
};

export class BridgeError extends Error {
  issues?: CompositionIssue[];
  constructor(message: string, issues?: CompositionIssue[]) {
    super(message);
    this.name = "BridgeError";
    this.issues = issues;
  }
}

/** The agent writes composition.json too. Thrown when our write would have
 *  landed on top of one we never saw — the caller must ask the user. */
export class ConflictError extends Error {
  /** the file's mtime as of the refusal: the base to re-send with when the
   *  user chooses 保留我的. */
  mtime: number;
  constructor(mtime: number) {
    super("composition.json changed on disk");
    this.name = "ConflictError";
    this.mtime = mtime;
  }
}

// The mtime composition.json had when we last read or wrote it, i.e. the
// version this editor's state descends from. Every server round-trip that
// touches the file re-bases it, so a DIFFERENT mtime showing up means someone
// else wrote — that's both the poll's signal and the write guard's base.
let baseMtime: number | undefined;
export const getBaseMtime = (): number | undefined => baseMtime;
export const setBaseMtime = (m: number | undefined): void => {
  baseMtime = m;
};

/** Probe the bridge. Returns the take payload, or null when not behind it. */
export async function detectBridge(): Promise<BridgeTake | null> {
  try {
    const r = await fetch("/api/take");
    if (!r.ok) return null;
    const take = (await r.json()) as BridgeTake;
    setBaseMtime(take.mtime);
    return take;
  } catch {
    return null;
  }
}

/** Send a free-text note to the agent: appended to `<base>.notes.md` and
 *  echoed on the edit-server's stdout as a NOTE line the agent can watch. */
export async function sendNote(text: string): Promise<void> {
  const r = await fetch("/api/notes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!r.ok) throw new BridgeError("note rejected");
}

/** mtime of composition.json on disk — lets the editor notice agent edits. */
export async function getCompositionMtime(): Promise<number | null> {
  try {
    const r = await fetch("/api/take/mtime");
    if (!r.ok) return null;
    return ((await r.json()) as { mtime: number }).mtime;
  } catch {
    return null;
  }
}

/** POST a composition with our concurrency base attached. Rejects with
 *  ConflictError when the server refuses to overwrite an unseen edit. */
async function postComposition(
  path: string,
  comp: TakeComposition,
  fallbackMessage: string,
): Promise<Record<string, unknown>> {
  const r = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ composition: comp, baseMtime: getBaseMtime() }),
  });
  const data = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (r.status === 409 && data.conflict) throw new ConflictError(data.mtime as number);
  if (!r.ok) throw new BridgeError((data.error as string) ?? fallbackMessage, data.issues as never);
  if (typeof data.mtime === "number") setBaseMtime(data.mtime);
  return data;
}

/** Persist composition.json without rendering. Throws BridgeError(issues) on
 *  400, ConflictError on 409. */
export async function saveComposition(comp: TakeComposition): Promise<void> {
  await postComposition("/api/composition", comp, "save rejected");
}

/** Kick off a render and resolve when the mp4 is written, streaming progress. */
export async function renderViaBridge(
  comp: TakeComposition,
  onProgress: (p: number) => void,
): Promise<{ mp4Url: string }> {
  const data = await postComposition("/api/render", comp, "render rejected");
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
      // POST /api/render already returned the mtime of its guarded write. The
      // renderer never rewrites composition.json, so `done` must not re-base:
      // an agent may legitimately have changed the file during the render.
      const done = JSON.parse((e as MessageEvent).data) as { mp4Url: string };
      resolve({ mp4Url: done.mp4Url });
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
