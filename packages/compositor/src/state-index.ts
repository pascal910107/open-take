// A saved interface state (`make --states`): the folder a `state` layer names
// holds state.html — the page as it stood at a settled moment of the
// recording, re-renderable offline — and index.json, what was on screen
// element by element. The runtime writes both (runtime/src/dom-state.ts);
// validation and the HTML renderer's staging read them here.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type StateElement = {
  /** "e<N>" — stable within its state */
  id: string;
  /** element-child indices from <html> */
  path: number[];
  tag: string;
  role?: string;
  name?: string;
  text?: string;
  /** viewport CSS px: x, y, width, height */
  box: [number, number, number, number];
  fixed?: true;
  interactive?: true;
};

export type StateIndex = {
  version: 1;
  id: string;
  url: string;
  title: string;
  /** capture timeline ms */
  tMs: number;
  /** the plan step it follows (absent for the first) */
  step?: number;
  viewport: { w: number; h: number; dpr: number };
  scroll: { x: number; y: number };
  elements: StateElement[];
  /** the page's major regions, back to front (element ids) */
  layers: string[];
  /** state.html re-rendered against the recording at capture time */
  fidelity?: { psnr: number; diffFrac: number; ok: boolean };
};

const positive = (v: unknown): v is number => typeof v === "number" && v > 0 && Number.isFinite(v);

/** The index of the saved state in `folder`, or why there is none. */
export function readStateIndex(folder: string): StateIndex | string {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(folder, "index.json"), "utf8"));
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT"
      ? `no saved state at ${folder} (index.json is missing — record the take with --states)`
      : `unreadable index.json in ${folder}: ${(e as Error).message}`;
  }
  const index = raw as Partial<StateIndex> | null;
  if (
    index?.version !== 1 ||
    !positive(index.viewport?.w) ||
    !positive(index.viewport?.h) ||
    !Array.isArray(index.elements)
  )
    return `index.json in ${folder} is not a version-1 saved state`;
  if (!existsSync(join(folder, "state.html"))) return `state.html is missing from ${folder}`;
  return index as StateIndex;
}
