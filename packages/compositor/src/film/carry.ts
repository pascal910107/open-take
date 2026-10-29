// What crossed each boundary of the beat sheet, read from the events file:
// a segment's `carry` (kit/time.js) names the one thing meant to live
// through the cut at its end, and the render followed that thing's box
// frame by frame, from 1 s before to 0.4 s after (the curves
// `carry@<to>:x|y|w|h|o|fw|fh`). Each boundary is then one of:
//   - carried: the thing was still on screen 0.25 s past the boundary (at
//     half its opacity or more), or grew from under half the frame to fill
//     it on its way there, and
//     it moved (≥ 2 % of the frame's diagonal) or changed size (≥ 10 %) —
//     the thing pressed became the result, a card turned into the map;
//   - anchored: it stayed across, unchanged — or only dissolved across,
//     still faintly there 0.25 s past the boundary (a scene sliding away
//     while the next comes in);
//   - bare: gone by then, or never on screen;
// and a boundary whose segment names no carry is "cut" (its handoff says so,
// on purpose), "words" (a handoff in words, nothing named to follow) or
// "unwritten". Thresholds after onetake's probe (references/rhythm.md: a
// survivor that moves 2 % of the diagonal or scales 10 % is carried), here
// on the one element the page names rather than guessed from the picture,
// so a carry built from two elements is seen as the one the page names.
// Facts, not a grade: nothing here says a boundary should be carried.

import type { FilmEvents, FilmSegment } from "./render";

/** how long before a boundary a carry is followed, and after (s): kit/time.js */
export const CARRY_BEFORE = 1;
export const CARRY_AFTER = 0.4;
/** still there this long past the boundary, at this opacity, it crossed */
export const CARRY_STAYS = 0.25;
const STAYS_OPACITY = 0.5;
/** a survivor that moves this share of the frame's diagonal has moved */
export const CARRY_MOVE = 0.02;
/** …or changes its size (√ of its area) by this share */
export const CARRY_SCALE = 0.1;
/** it fills the frame when it covers this share of it */
export const CARRY_FILL = 0.85;
/** drawn at less than this opacity it is not on screen */
const SEEN_OPACITY = 0.1;

export type CarryKind = "carried" | "anchored" | "bare";

export type BoundaryCarry = {
  /** the boundary, s on the film's own clock */
  at: number;
  /** the handoff written on the segment ending here, if any */
  handoff?: string;
  /** what the segment named to follow, if anything */
  carry?: string;
  how:
    | { kind: CarryKind; measured: true; scale: number; move: number; fill: number; note?: string }
    | { kind: "cut" | "words" | "unwritten" | "not rendered"; measured: false };
};

export type CarrySample = { t: number; x: number; y: number; w: number; h: number; o: number };

/** the curve a carry is written as (kit/time.js carryCurve) */
export const carryCurve = (at: number, field: string) => `carry@${+at.toFixed(3)}:${field}`;

/** a boundary's samples from the events file's curves, in time order */
export function carrySamples(
  ev: Pick<FilmEvents, "curves">,
  at: number,
): {
  samples: CarrySample[];
  frame: { w: number; h: number } | null;
} {
  const { names, t0, dt, rows } = ev.curves;
  const col = (f: string) => names.indexOf(carryCurve(at, f));
  const [ix, iy, iw, ih, io, ifw, ifh] = ["x", "y", "w", "h", "o", "fw", "fh"].map(col);
  const samples: CarrySample[] = [];
  let frame: { w: number; h: number } | null = null;
  if (ix! < 0) return { samples, frame };
  rows.forEach((r, i) => {
    const v = [ix, iy, iw, ih, io].map((k) => (k! >= 0 ? r[k!] : null));
    if (v.some((x) => x == null)) return;
    const [x, y, w, h, o] = v as number[];
    samples.push({ t: t0 + i * dt, x: x!, y: y!, w: w!, h: h!, o: o! });
    const fw = ifw! >= 0 ? r[ifw!] : null;
    const fh = ifh! >= 0 ? r[ifh!] : null;
    if (!frame && fw != null && fh != null && fw > 0 && fh > 0) frame = { w: fw, h: fh };
  });
  return { samples, frame };
}

/** how much of the frame a box covers, 0..1 */
function cover(s: CarrySample, f: { w: number; h: number }): number {
  const w = Math.max(0, Math.min(s.x + s.w, f.w) - Math.max(s.x, 0));
  const h = Math.max(0, Math.min(s.y + s.h, f.h) - Math.max(s.y, 0));
  return (w * h) / (f.w * f.h);
}

/** what one followed thing did across its boundary */
export function classifyCarry(
  samples: readonly CarrySample[],
  at: number,
  frame: { w: number; h: number },
  dt: number,
): { kind: CarryKind; scale: number; move: number; fill: number; note?: string } {
  const seen = samples.filter((s) => s.o >= SEEN_OPACITY && s.w * s.h > 0 && cover(s, frame) > 0);
  const fill = seen.length ? Math.max(...seen.map((s) => cover(s, frame))) : 0;
  if (!seen.length)
    return { kind: "bare", scale: 1, move: 0, fill: 0, note: "not on screen near the boundary" };
  // the far side starts a little past the boundary: a frame on it can still
  // be the outgoing side's last, drawn on the shutter
  const before = seen.filter((s) => s.t < at - dt / 2);
  // a scene sliding out while it fades is not one that crossed
  const after = seen.filter((s) => s.t >= at + CARRY_STAYS - 1e-6 && s.o >= STAYS_OPACITY);
  const ref = before[0] ?? seen[0]!;
  const diag = Math.hypot(frame.w, frame.h);
  const size = (s: CarrySample) => Math.sqrt(s.w * s.h);
  let scale = 1;
  let move = 0;
  for (const s of seen) {
    const k = size(s) / size(ref);
    if (Math.abs(Math.log(k)) > Math.abs(Math.log(scale))) scale = k;
    move = Math.max(
      move,
      Math.hypot(s.x + s.w / 2 - (ref.x + ref.w / 2), s.y + s.h / 2 - (ref.y + ref.h / 2)) / diag,
    );
  }
  const r = (v: number) => Math.round(v * 100) / 100;
  const out = { scale: r(scale), move: r(move), fill: r(fill) };
  if (!before.length)
    return { kind: "bare", ...out, note: "first on screen only after the boundary" };
  // filling the frame counts when it grew to: a whole scene fills it anyway
  const grewToFill = fill >= CARRY_FILL && cover(ref, frame) < 0.5;
  const across = after.length > 0 || grewToFill;
  if (!across) {
    // still drawn, faintly, past the boundary: it dissolved across rather than left
    const fading = seen.some((s) => s.t >= at + CARRY_STAYS - 1e-6);
    return fading
      ? { kind: "anchored", ...out, note: "fading out across the boundary" }
      : { kind: "bare", ...out, note: `gone ${CARRY_STAYS} s past the boundary` };
  }
  const changed = move >= CARRY_MOVE || Math.abs(scale - 1) >= CARRY_SCALE;
  return { kind: changed ? "carried" : "anchored", ...out };
}

const isCut = (h: string | undefined) => !!h && /^\s*(hard\s+)?cut\s*$/i.test(h);

/** every boundary of the beat sheet inside the film (a segment's end before
 *  the film's), and what crossed it; `from` is where the film starts on the
 *  page's timeline (a render of part of it) */
export function boundaryCarries(
  ev: Pick<FilmEvents, "curves" | "segments" | "duration" | "fps"> & { range?: [number, number] },
  from = 0,
): BoundaryCarry[] {
  const end = ev.range ? ev.range[1] : ev.duration;
  const start = ev.range ? ev.range[0] : 0;
  const byAt = new Map<number, FilmSegment>();
  for (const s of ev.segments as FilmSegment[]) {
    if (!(s.to < ev.duration - 1e-6)) continue;
    const k = +s.to.toFixed(3);
    const had = byAt.get(k);
    // two segments ending together name one boundary: the first carry and the
    // first handoff written for it (time.js follows that first carry)
    byAt.set(
      k,
      had
        ? {
            ...had,
            ...(had.carry || !s.carry ? {} : { carry: s.carry }),
            ...(had.handoff || !s.handoff ? {} : { handoff: s.handoff }),
          }
        : s,
    );
  }
  const out: BoundaryCarry[] = [];
  for (const [at, s] of [...byAt].sort((a, b) => a[0] - b[0])) {
    const base = {
      at: +(at - from).toFixed(3),
      ...(s.handoff ? { handoff: s.handoff } : {}),
      ...(s.carry ? { carry: s.carry } : {}),
    };
    if (!s.carry) {
      out.push({
        ...base,
        how: {
          kind: isCut(s.handoff) ? "cut" : s.handoff ? "words" : "unwritten",
          measured: false,
        },
      });
      continue;
    }
    if (at < start - 1e-6 || at > end + 1e-6) {
      out.push({ ...base, how: { kind: "not rendered", measured: false } });
      continue;
    }
    const { samples, frame } = carrySamples(ev, at);
    if (!samples.length || !frame) {
      out.push({ ...base, how: { kind: "not rendered", measured: false } });
      continue;
    }
    out.push({
      ...base,
      how: { measured: true, ...classifyCarry(samples, at, frame, 1 / ev.fps) },
    });
  }
  return out;
}

/** a boundary's change in words: "grew ×4.2 to fill the frame", "moved 12 % of the frame" */
export function carryChange(b: BoundaryCarry): string {
  if (!b.how.measured) return "";
  const { scale, move, fill } = b.how;
  const parts: string[] = [];
  if (Math.abs(scale - 1) >= CARRY_SCALE)
    parts.push(scale > 1 ? `grew ×${scale.toFixed(1)}` : `shrank to ×${scale.toFixed(2)}`);
  if (move >= CARRY_MOVE) parts.push(`moved ${Math.round(move * 100)}% of the diagonal`);
  if (fill >= CARRY_FILL && Math.abs(scale - 1) >= CARRY_SCALE) parts.push("filled the frame");
  return parts.join(", ");
}
