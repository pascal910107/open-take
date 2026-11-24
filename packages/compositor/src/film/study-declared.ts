// What a film's own page declared about its boundaries, for `film study` to
// set beside what it reads from the picture. A film rendered with this tool
// has <film>.events.json next to it: events of kind "cut" and "hidden-cut",
// the beat sheet's segments with their handoffs, and for a segment that names
// a carry, the box of that thing followed across the boundary by the render.
// A cut the page made on purpose with something flying across it looks, on a
// small grey copy, like any other hard cut; the declaration says what it was
// meant as and the render's own measurement says whether the thing crossed.
// A film from elsewhere has no such file and is read from the picture alone.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { type BoundaryCarry, boundaryCarries, carryChange } from "./carry";
import { eventsPathFor, type FilmEvents } from "./render";

export type DeclaredBoundary = {
  /** s on the film's own clock */
  at: number;
  /** the kinds of the page's events here: "cut", "hidden-cut", or the page's own word */
  kinds: string[];
  /** those events' labels */
  labels: string[];
  /** the handoff written on the segment ending here */
  handoff?: string;
  /** what that segment named to follow across */
  carry?: string;
  /** what the render measured of that thing (carry.ts), when it named one */
  carried?: { kind: "carried" | "anchored" | "bare"; change: string; note?: string };
};

export type Declarations = { file: string; boundaries: DeclaredBoundary[] };

/** why an events file beside a film was left unread */
export type DeclarationsSkipped = { file: string; skipped: string };

const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** The boundaries an events file declares, on the film's clock: every "cut"
 *  and "hidden-cut" event and every segment that ends before the film does.
 *  Other events at one of those times (a "whip", say) lend their kind and
 *  label. Times within `tolerance` seconds are one boundary. */
export function declaredBoundaries(ev: FilmEvents, tolerance: number): DeclaredBoundary[] {
  const from = ev.range?.[0] ?? 0;
  const to = ev.range?.[1] ?? ev.duration;
  const inside = (t: number) => t > from + tolerance && t < to - tolerance;
  const out: DeclaredBoundary[] = [];
  const at = (t: number) => {
    const film = +(t - from).toFixed(6);
    let b = out.find((x) => Math.abs(x.at - film) <= tolerance);
    if (!b) {
      b = { at: film, kinds: [], labels: [] };
      out.push(b);
    }
    return b;
  };
  for (const e of ev.events)
    if ((e.kind === "cut" || e.kind === "hidden-cut") && inside(e.t)) at(e.t);
  const carries = new Map<number, BoundaryCarry>();
  for (const c of boundaryCarries(ev, from)) {
    const page = c.at + from;
    if (!inside(page)) continue;
    carries.set(at(page).at, c);
  }
  for (const b of out) {
    for (const e of ev.events) {
      if (e.kind === "mark" || Math.abs(e.t - from - b.at) > tolerance) continue;
      if (!b.kinds.includes(e.kind)) b.kinds.push(e.kind);
      if (e.label && !b.labels.includes(e.label)) b.labels.push(e.label);
    }
    const c = carries.get(b.at);
    if (!c) continue;
    if (c.handoff) b.handoff = c.handoff;
    if (c.carry) b.carry = c.carry;
    if (c.how.measured)
      b.carried = {
        kind: c.how.kind,
        change: carryChange(c),
        ...(c.how.note ? { note: c.how.note } : {}),
      };
  }
  return out.sort((a, b) => a.at - b.at);
}

/** The declarations beside a film, when its events file is there and is this
 *  film's: null when there is none (a film from elsewhere), `skipped` when a
 *  file is there but cannot be this film's. `duration` is the picture's. */
export async function readDeclarations(
  film: string,
  duration: number,
  frameSeconds: number,
): Promise<Declarations | DeclarationsSkipped | null> {
  const file = eventsPathFor(film);
  if (!existsSync(file)) return null;
  let ev: FilmEvents;
  try {
    ev = JSON.parse(await readFile(file, "utf8")) as FilmEvents;
  } catch {
    return { file, skipped: "it is not JSON" };
  }
  if (!ev || !isNumber(ev.duration) || !isNumber(ev.fps) || !Array.isArray(ev.events))
    return { file, skipped: "it is not an events file" };
  const range = Array.isArray(ev.range) && ev.range.every(isNumber) ? ev.range : undefined;
  const length = range ? range[1] - range[0] : ev.duration;
  // A film re-cut or trimmed after the render no longer shares its clock.
  if (Math.abs(length - duration) > 0.5)
    return {
      file,
      skipped: `it describes ${length.toFixed(2)} s and the picture runs ${duration.toFixed(2)} s`,
    };
  const clean: FilmEvents = {
    ...ev,
    range,
    events: ev.events.filter((e) => e && isNumber(e.t) && typeof e.kind === "string"),
    segments: (Array.isArray(ev.segments) ? ev.segments : []).filter(
      (s) => s && isNumber(s.from) && isNumber(s.to),
    ),
    curves:
      ev.curves && Array.isArray(ev.curves.names) && Array.isArray(ev.curves.rows)
        ? ev.curves
        : { names: [], t0: 0, dt: 1 / ev.fps, rows: [] },
  };
  return { file, boundaries: declaredBoundaries(clean, 1.5 * frameSeconds) };
}
