// A saved interface state (`make --states`): the folder a `state` layer names
// holds state.html — the page as it stood at a settled moment of the
// recording, re-renderable offline — and index.json, what was on screen
// element by element. The runtime writes both (runtime/src/dom-state.ts);
// validation and the HTML renderer's staging read them here.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { elementLabel, subtree } from "./state-diff";

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

/** The elements a film could lift out on their own: at least two labelled
 *  things inside, 0.3–20% of the page, and — of a chain of wrappers that
 *  share one box — the outermost (`maxFrac` raises the 20%). Element ids of `index`. (`open-take states`
 *  marks these as cards; the component probe adds the visual test on top.) */
export function cardsOf(
  index: StateIndex,
  byPath?: Map<string, StateElement>,
  opts: { maxFrac?: number } = {},
): Set<string> {
  const maxFrac = opts.maxFrac ?? 0.2;
  const paths = byPath ?? new Map(index.elements.map((e) => [e.path.join("."), e]));
  const page = index.viewport.w * index.viewport.h;
  const area = (b: StateElement["box"]) => Math.max(0, b[2]) * Math.max(0, b[3]);
  const sameBox = (a: StateElement["box"], b: StateElement["box"]) =>
    a.every((v, i) => Math.abs(v - b[i]!) <= 2);
  const qualifies = new Set<string>();
  for (const e of index.elements) {
    const frac = area(e.box) / page;
    if (frac < 0.003 || frac > maxFrac) continue;
    let labelled = 0;
    for (const d of subtree(index, e.id)) if (d.id !== e.id && elementLabel(d).trim()) labelled++;
    if (labelled >= 2) qualifies.add(e.id);
  }
  const cards = new Set<string>();
  for (const e of index.elements) {
    if (!qualifies.has(e.id)) continue;
    const parent = paths.get(e.path.slice(0, -1).join("."));
    if (parent && parent !== e && qualifies.has(parent.id) && sameBox(parent.box, e.box)) continue;
    cards.add(e.id);
  }
  return cards;
}
