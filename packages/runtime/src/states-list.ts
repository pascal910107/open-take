// `open-take states <take>` — what a recording's saved states contain and
// what each recorded action changed, for a model that is about to write a
// film from it. Reads the take's capture.json (the actions, and which
// saved state followed each) and states/<id>/index.json (what was on screen,
// element by element — see compositor/src/state-index.ts) and describes the
// difference between neighbouring states at the level a viewer notices: a
// card that appeared, a number that changed, a box that moved.
//
// Two contracts a film leans on when it names what it shows: actions are
// numbered a1..aN in capture order, and element ids are PER STATE (the same button can be e52
// in s1 and e83 in s3), so an element is always named with its state —
// s3:e32. The diff itself comes from the compositor's state-diff helpers;
// this file only decides what is worth a line.

import { readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import {
  type CaptureEvent,
  type CaptureLog,
  contentOf,
  diffStates,
  elementLabel,
  matchStates,
  readStateIndex,
  type StateChange,
  type StateElement,
  type StateIndex,
  subtree,
} from "@open-take/compositor";

type Box = [number, number, number, number];
type BBox = { x: number; y: number; w: number; h: number };

// --- the data ------------------------------------------------------------------

/** One major region of a state (the probe's `layers`, back to front). */
export type StateRegion = {
  id: string;
  /** "s3:e26" */
  ref: string;
  /** where it sits: top bar / right rail / main / nav / … */
  name: string;
  tag: string;
  box: Box;
  fixed?: true;
  /** its visible texts, in order */
  summary: string;
  /** paint surfaces and images inside it ("canvas", "18 img") — what no text
   *  and no DOM re-render can stand in for */
  holds?: string;
};

/** One line of what changed between a state and the one before it. */
export type StateChangeLine = {
  kind: "added" | "removed" | "replaced" | "changed";
  /** "s3:e32" — in the state named (the PREVIOUS state for a removal) */
  ref: string;
  id: string;
  state: string;
  tag: string;
  role?: string;
  box: Box;
  /** the box before, when it moved or resized */
  from?: Box;
  /** what it shows now: its subtree's texts (added / replaced), its label
   *  (a relabel) */
  content?: string;
  /** what it showed before (replaced / a relabel) */
  was?: string;
  /** the visible text, when only the accessible name changed */
  visible?: string;
  /** qualifies as a card (see `StateOutline`) */
  card?: true;
  /** a run of same-tag siblings added to / removed from `ref` */
  count?: number;
  /** raw diff entries this line stands for */
  covers: number;
  /** 0 = something a viewer reads · 1 = a visible thing moved · 2 = unlabelled geometry */
  priority: 0 | 1 | 2;
};

export type StateSummary = {
  id: string;
  /** capture timeline ms */
  tMs: number;
  /** the plan step it follows (absent for s0) */
  step?: number;
  /** the action it follows ("a2") — absent for s0 and for a wait / navigate step */
  after?: string;
  /** ok · failed (state.html does not match the recording — use the video
   *  there) · missing (no readable index.json) · moving (the page never went
   *  quiet here, a video playing: nothing was saved) */
  status: "ok" | "failed" | "missing" | "moving";
  fidelity?: { psnr: number; diffFrac: number; ok: boolean };
  /** why the index could not be read (status missing) */
  error?: string;
  url?: string;
  title?: string;
  elements?: number;
  regions?: StateRegion[];
  /** the diff from the previous state, in document order (removals last) */
  changes?: StateChangeLine[];
  /** where pixels changed after the action that led here (the capture's
   *  frame-diff). `unexplained`: no element change accounts for it — a
   *  canvas / CSS-only change the DOM diff cannot see. */
  pixels?: { box: BBox; coverage?: number; unexplained: boolean };
};

export type ActionTarget = {
  state: string;
  id: string;
  /** "s2:e118" */
  ref: string;
  tag: string;
  role?: string;
  label: string;
  box: Box;
  /** how it was found: the capture's own box match, or the element under the
   *  action's point (drags carry no box) */
  by: "capture" | "point";
};

export type ActionSummary = {
  /** "a1".."aN", capture order */
  id: string;
  kind: string;
  /** the plan's text / selector label, as the capture recorded it */
  label?: string;
  tMs: number;
  /** tMs + how long the action played out (type / drag / hover / …) */
  endMs?: number;
  /** anchor, viewport CSS px */
  x: number;
  y: number;
  to?: { x: number; y: number };
  box?: BBox;
  /** the state before it (the one its target lives in) */
  before?: string;
  /** the state captured after it settled */
  after?: string;
  target?: ActionTarget;
  effectBox?: BBox;
  changeCoverage?: number;
  /** typed text (type) */
  text?: string;
  /** chord (press) */
  keys?: string;
  /** signed px (scroll) */
  dy?: number;
  /** dropped file names (dropFiles) */
  files?: string[];
  caption?: string;
  note?: string;
};

export type TakeStates = {
  /** "editor.take" */
  take: string;
  /** the states folder, absolute */
  dir: string;
  viewport: { w: number; h: number; dpr?: number };
  /** of the states a page was saved for: how many match the recording; and
   *  the moments with no saved page (moving) or no readable one (missing) */
  fidelity: { ok: number; total: number; failed: string[]; moving: string[]; missing: string[] };
  actions: ActionSummary[];
  states: StateSummary[];
};

// --- geometry + labels -----------------------------------------------------------

const area = (b: Box): number => Math.max(0, b[2]) * Math.max(0, b[3]);
const contains = (b: Box, x: number, y: number): boolean =>
  x >= b[0] && x <= b[0] + b[2] && y >= b[1] && y <= b[1] + b[3];
const near = (u: number, v: number): boolean => Math.abs(u - v) <= 2;
const sameBox = (a: Box, b: Box): boolean => a.every((v, i) => near(v, b[i]!));
const overlap = (a: Box, b: Box): number => {
  const w = Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]);
  return Math.max(0, w) * Math.max(0, h);
};
const toBox = (b: BBox): Box => [b.x, b.y, b.w, b.h];
const pathKey = (p: number[]): string => p.join(".");
const parentKey = (e: StateElement): string => pathKey(e.path.slice(0, -1));
const isAncestorPath = (p: number[], q: number[]): boolean =>
  p.length < q.length && p.every((v, i) => q[i] === v);
const labelOf = (e: StateElement): string => elementLabel(e).trim();
const dedup = (xs: string[]): string[] => [...new Set(xs)];
const joinTexts = (xs: string[]): string =>
  xs
    .map((x) => x.replace(/\s*·\s*$/, "").trim())
    .filter(Boolean)
    .join(" · ");

/** A state with its lookups: parent by path, children, document order, and
 *  which elements are cards. */
type Indexed = {
  index: StateIndex;
  byId: Map<string, StateElement>;
  byPath: Map<string, StateElement>;
  children: Map<string, StateElement[]>;
  order: Map<string, number>;
  cards: Set<string>;
};

function indexed(index: StateIndex): Indexed {
  const byId = new Map(index.elements.map((e) => [e.id, e]));
  const byPath = new Map(index.elements.map((e) => [pathKey(e.path), e]));
  const children = new Map<string, StateElement[]>();
  const order = new Map<string, number>();
  index.elements.forEach((e, i) => {
    order.set(e.id, i);
    const parent = byPath.get(parentKey(e));
    if (!parent || parent === e) return;
    const list = children.get(parent.id) ?? [];
    list.push(e);
    children.set(parent.id, list);
  });
  return { index, byId, byPath, children, order, cards: cardsOf(index, byPath) };
}

/** The elements a film could lift out on their own: at least two labelled
 *  things inside, 0.3–20% of the page, and — of a chain of wrappers that
 *  share one box — the outermost. */
function cardsOf(index: StateIndex, byPath: Map<string, StateElement>): Set<string> {
  const page = index.viewport.w * index.viewport.h;
  const qualifies = new Set<string>();
  for (const e of index.elements) {
    const frac = area(e.box) / page;
    if (frac < 0.003 || frac > 0.2) continue;
    let labelled = 0;
    for (const d of subtree(index, e.id)) if (d.id !== e.id && labelOf(d)) labelled++;
    if (labelled >= 2) qualifies.add(e.id);
  }
  const cards = new Set<string>();
  for (const e of index.elements) {
    if (!qualifies.has(e.id)) continue;
    const parent = byPath.get(parentKey(e));
    if (parent && parent !== e && qualifies.has(parent.id) && sameBox(parent.box, e.box)) continue;
    cards.add(e.id);
  }
  return cards;
}

/** The element under a point: the smallest interactive one, else the
 *  smallest of any kind. */
function elementAt(index: StateIndex, x: number, y: number): StateElement | undefined {
  let best: StateElement | undefined;
  for (const e of index.elements) {
    if (!contains(e.box, x, y)) continue;
    if (!best) {
      best = e;
      continue;
    }
    const better = e.interactive
      ? !best.interactive || area(e.box) < area(best.box)
      : !best.interactive && area(e.box) < area(best.box);
    if (better) best = e;
  }
  return best;
}

const SEMANTIC: Record<string, string> = {
  header: "header",
  nav: "nav",
  aside: "sidebar",
  main: "main",
  footer: "footer",
  dialog: "dialog",
  form: "form",
};

/** What to call a region: its landmark tag when it has one, else where it
 *  sits on the page. */
function regionName(e: StateElement, vw: number, vh: number): string {
  const [x, y, w, h] = e.box;
  const wide = w >= 0.8 * vw;
  const tall = h >= 0.6 * vh;
  const position =
    wide && h <= 0.25 * vh
      ? y <= 0.1 * vh
        ? "top bar"
        : y + h >= 0.9 * vh
          ? "bottom bar"
          : "band"
      : tall && w <= 0.35 * vw
        ? x <= 0.1 * vw
          ? "left rail"
          : x + w >= 0.9 * vw
            ? "right rail"
            : "column"
        : w >= 0.5 * vw && h >= 0.5 * vh
          ? "main"
          : "panel";
  const semantic =
    SEMANTIC[e.tag] ??
    (e.role === "navigation" ? "nav" : e.role === "dialog" ? "dialog" : undefined);
  const name = semantic ?? position;
  return e.fixed ? `${name} (fixed)` : name;
}

/** What text cannot show: a stage, a filmstrip, an embed. */
const HOLDS_TAGS = ["canvas", "video", "iframe", "img"];

/** "canvas · 18 img" — the paint surfaces and images inside an element, or "". */
function holdsOf(index: StateIndex, id: string): string {
  const counts = new Map<string, number>();
  for (const e of subtree(index, id))
    if (e.id !== id) counts.set(e.tag, (counts.get(e.tag) ?? 0) + 1);
  const parts: string[] = [];
  for (const tag of HOLDS_TAGS) {
    const n = counts.get(tag);
    if (n) parts.push(n === 1 ? tag : `${n} ${tag}`);
  }
  return parts.join(" · ");
}

function regionsOf(ix: Indexed, stateId: string): StateRegion[] {
  const { w, h } = ix.index.viewport;
  const out: StateRegion[] = [];
  for (const id of ix.index.layers) {
    const e = ix.byId.get(id);
    if (!e) continue;
    out.push({
      id,
      ref: `${stateId}:${id}`,
      name: regionName(e, w, h),
      tag: e.tag,
      box: e.box,
      ...(e.fixed ? { fixed: true } : {}),
      summary: joinTexts(contentOf(ix.index, id)),
      ...(holdsOf(ix.index, id) ? { holds: holdsOf(ix.index, id) } : {}),
    });
  }
  return out;
}

// --- the diff, at the level a viewer notices --------------------------------------------

type Changed = Extract<StateChange, { kind: "changed" }>;

const deltaOf = (c: Changed): Box => [
  c.b.box[0] - c.a.box[0],
  c.b.box[1] - c.a.box[1],
  c.b.box[2] - c.a.box[2],
  c.b.box[3] - c.a.box[3],
];
const sameDelta = (p: Box, q: Box): boolean => p.every((v, i) => near(v, q[i]!));

/** The changes from `A` to `B`, grouped: an added subtree is one line at its
 *  outermost added element; an existing element whose children were mostly
 *  swapped is one "was → now" line; a run of three or more same-tag siblings
 *  is one line; a wrapper that moved exactly as one of its children did is
 *  left out, and so is a child that merely rode along with its parent. */
function summarizeChanges(A: Indexed, B: Indexed, aId: string, bId: string): StateChangeLine[] {
  const a = A.index;
  const b = B.index;
  const raw = diffStates(a, b);
  const back = new Map<string, string>();
  for (const [ia, ib] of matchStates(a, b)) back.set(ib, ia);
  const added = new Set<string>();
  const removed = new Set<string>();
  const changed = new Map<string, Changed>();
  for (const c of raw) {
    if (c.kind === "added") added.add(c.b.id);
    else if (c.kind === "removed") removed.add(c.a.id);
    else changed.set(c.b.id, c);
  }
  const coveredA = new Set<string>();
  const coveredB = new Set<string>();
  const coverA = (id: string) => {
    for (const e of subtree(a, id)) coveredA.add(e.id);
  };
  const coverB = (id: string) => {
    for (const e of subtree(b, id)) coveredB.add(e.id);
  };
  const rawIn = (index: StateIndex, id: string, set: Set<string>): number =>
    subtree(index, id).filter((e) => set.has(e.id)).length;
  const lines: (StateChangeLine & { order: number })[] = [];
  const refA = (id: string) => `${aId}:${id}`;
  const refB = (id: string) => `${bId}:${id}`;
  const roleOf = (e: StateElement) => (e.role ? { role: e.role } : {});

  // Added elements, grouped under their outermost added ancestor, then by parent.
  const addedRoots = new Map<string, StateElement[]>();
  for (const e of b.elements) {
    if (!added.has(e.id)) continue;
    const parent = B.byPath.get(parentKey(e));
    if (parent && parent !== e && added.has(parent.id)) continue;
    const key = parent && parent !== e ? parent.id : "";
    const list = addedRoots.get(key) ?? [];
    list.push(e);
    addedRoots.set(key, list);
  }
  for (const [parentId, allRoots] of addedRoots) {
    const roots = allRoots.filter((r) => !coveredB.has(r.id));
    if (!roots.length) continue;
    const parent = parentId ? B.byId.get(parentId) : undefined;
    const parentA = parent ? A.byId.get(back.get(parent.id) ?? "") : undefined;
    if (parent && parentA) {
      // the parent existed: did the action swap out what it held?
      const oldKids = A.children.get(parentA.id) ?? [];
      const newKids = B.children.get(parent.id) ?? [];
      const gone = oldKids.filter((k) => removed.has(k.id)).length;
      const swapped =
        oldKids.length === 0 || (gone * 2 >= oldKids.length && roots.length * 2 >= newKids.length);
      if (swapped) {
        const content = joinTexts(contentOf(b, parent.id));
        const was = joinTexts(contentOf(a, parentA.id));
        const ch = changed.get(parent.id);
        lines.push({
          kind: "replaced",
          ref: refB(parent.id),
          id: parent.id,
          state: bId,
          tag: content ? parent.tag : roots[0]!.tag,
          ...roleOf(parent),
          box: parent.box,
          ...(ch && (ch.moved || ch.resized) ? { from: ch.a.box } : {}),
          content,
          was,
          ...(B.cards.has(parent.id) ? { card: true } : {}),
          ...(content ? {} : { count: roots.length }),
          covers:
            rawIn(b, parent.id, added) +
            rawIn(a, parentA.id, removed) +
            subtree(b, parent.id).filter((e) => changed.has(e.id)).length,
          priority: content || was ? 0 : 2,
          order: B.order.get(parent.id)!,
        });
        coverB(parent.id);
        coverA(parentA.id);
        continue;
      }
    }
    if (parent && roots.length >= 3 && roots.every((r) => r.tag === roots[0]!.tag)) {
      const content = joinTexts(dedup(roots.flatMap((r) => contentOf(b, r.id))));
      lines.push({
        kind: "added",
        ref: refB(parent.id),
        id: parent.id,
        state: bId,
        tag: roots[0]!.tag,
        box: parent.box,
        content,
        count: roots.length,
        covers: roots.reduce((n, r) => n + subtree(b, r.id).length, 0),
        priority: content ? 0 : 2,
        order: B.order.get(roots[0]!.id)!,
      });
      for (const r of roots) coverB(r.id);
      continue;
    }
    for (const r of roots) {
      const content = joinTexts(contentOf(b, r.id));
      lines.push({
        kind: "added",
        ref: refB(r.id),
        id: r.id,
        state: bId,
        tag: r.tag,
        ...roleOf(r),
        box: r.box,
        content,
        ...(B.cards.has(r.id) ? { card: true } : {}),
        covers: subtree(b, r.id).length,
        priority: content || r.interactive ? 0 : 2,
        order: B.order.get(r.id)!,
      });
      coverB(r.id);
    }
  }

  // Removed elements — the ids are the previous state's.
  const removedRoots = new Map<string, StateElement[]>();
  for (const e of a.elements) {
    if (!removed.has(e.id) || coveredA.has(e.id)) continue;
    const parent = A.byPath.get(parentKey(e));
    if (parent && parent !== e && removed.has(parent.id)) continue;
    const key = parent && parent !== e ? parent.id : "";
    const list = removedRoots.get(key) ?? [];
    list.push(e);
    removedRoots.set(key, list);
  }
  const offset = b.elements.length;
  for (const [parentId, roots] of removedRoots) {
    const parent = parentId ? A.byId.get(parentId) : undefined;
    if (parent && roots.length >= 3 && roots.every((r) => r.tag === roots[0]!.tag)) {
      const content = joinTexts(dedup(roots.flatMap((r) => contentOf(a, r.id))));
      lines.push({
        kind: "removed",
        ref: refA(parent.id),
        id: parent.id,
        state: aId,
        tag: roots[0]!.tag,
        box: parent.box,
        content,
        count: roots.length,
        covers: roots.reduce((n, r) => n + subtree(a, r.id).length, 0),
        priority: content ? 0 : 2,
        order: offset + A.order.get(roots[0]!.id)!,
      });
      for (const r of roots) coverA(r.id);
      continue;
    }
    for (const r of roots) {
      const content = joinTexts(contentOf(a, r.id));
      lines.push({
        kind: "removed",
        ref: refA(r.id),
        id: r.id,
        state: aId,
        tag: r.tag,
        ...roleOf(r),
        box: r.box,
        content,
        ...(A.cards.has(r.id) ? { card: true } : {}),
        covers: subtree(a, r.id).length,
        priority: content || r.interactive ? 0 : 2,
        order: offset + A.order.get(r.id)!,
      });
      coverA(r.id);
    }
  }

  // Elements found in both: a relabel, a move, a resize. A move prints at the
  // outermost mover (what is inside rode along); a pure resize prints at the
  // innermost (a wrapper that grew exactly as its content did just followed).
  const printedMoves: { e: StateElement; d: Box }[] = [];
  for (const c of raw)
    if (c.kind === "changed" && coveredB.has(c.b.id) && (c.moved || c.resized))
      printedMoves.push({ e: c.b, d: deltaOf(c) }); // spoken for by a swap line above
  for (const c of raw) {
    if (c.kind !== "changed" || coveredB.has(c.b.id)) continue;
    const oldLabel = labelOf(c.a);
    const newLabel = labelOf(c.b);
    let text = c.text;
    if (text) {
      // an ancestor's own relabel already reads this one (the bold number
      // inside a relabelled span)
      for (const o of raw) {
        if (o.kind !== "changed" || !o.text || o === c || !isAncestorPath(o.b.path, c.b.path))
          continue;
        if (labelOf(o.a).includes(oldLabel) && labelOf(o.b).includes(newLabel)) {
          text = false;
          break;
        }
      }
    }
    let motion = c.moved || c.resized;
    const d = deltaOf(c);
    if (c.moved) {
      const rides = printedMoves.some(
        (m) =>
          isAncestorPath(m.e.path, c.b.path) &&
          near(m.d[0], d[0]) &&
          near(m.d[1], d[1]) &&
          (!c.resized || (near(m.d[2], d[2]) && near(m.d[3], d[3]))),
      );
      if (rides) motion = false;
    } else if (c.resized) {
      const followsContent = raw.some(
        (o) =>
          o.kind === "changed" &&
          o !== c &&
          !o.moved &&
          o.resized &&
          isAncestorPath(c.b.path, o.b.path) &&
          sameDelta(deltaOf(o), d),
      );
      if (followsContent) motion = false;
    }
    if (!text && !motion) continue;
    if (motion) printedMoves.push({ e: c.b, d });
    const aText = c.a.text?.trim() ?? "";
    const visible =
      text && c.b.interactive && aText && aText === (c.b.text?.trim() ?? "") ? aText : undefined;
    const card = B.cards.has(c.b.id);
    lines.push({
      kind: "changed",
      ref: refB(c.b.id),
      id: c.b.id,
      state: bId,
      tag: c.b.tag,
      ...roleOf(c.b),
      box: c.b.box,
      ...(motion ? { from: c.a.box } : {}),
      ...(text ? { was: oldLabel, content: newLabel } : {}),
      ...(visible ? { visible } : {}),
      ...(card ? { card: true } : {}),
      covers: 1,
      priority: text ? 0 : newLabel || c.b.interactive || card ? 1 : 2,
      order: B.order.get(c.b.id)!,
    });
  }
  lines.sort((p, q) => p.order - q.order);
  return lines.map(({ order: _order, ...line }) => line);
}

/** Pixels changed over a region no element change touches: a canvas
 *  repaint, a CSS-only restyle — the film must use the recording there. */
function pixelsUnexplained(effect: BBox, changes: StateChangeLine[], page: number): boolean {
  const box = toBox(effect);
  const size = area(box);
  if (size < 0.02 * page) return false;
  let covered = 0;
  for (const c of changes) {
    covered += overlap(box, c.box);
    if (c.from) covered += overlap(box, c.from);
  }
  return covered < 0.05 * size;
}

// --- actions --------------------------------------------------------------------------

/** Kinds whose anchor is on the thing they act on (a scroll's or a press's
 *  anchor is just where the cursor rests). */
const POINT_KINDS = new Set(["click", "type", "drag", "hover", "look", "dropFiles"]);

function describeAction(
  e: CaptureEvent,
  i: number,
  items: NonNullable<CaptureLog["states"]>["items"],
  indexOf: (id: string | undefined) => StateIndex | undefined,
): ActionSummary {
  const kind = e.kind ?? "click";
  const afterIdx = e.state ? items.findIndex((s) => s.id === e.state) : -1;
  let before: string | undefined;
  if (afterIdx > 0) before = items[afterIdx - 1]!.id;
  else for (const it of items) if (it.tMs <= e.tMs) before = it.id;
  const beforeIndex = indexOf(before);
  const point = e.kind === "dropFiles" ? e.to : { x: e.x, y: e.y };
  let el: StateElement | undefined;
  let by: ActionTarget["by"] = "capture";
  if (e.target && beforeIndex) el = beforeIndex.elements.find((x) => x.id === e.target);
  if (!el && beforeIndex && POINT_KINDS.has(kind)) {
    el = elementAt(beforeIndex, point.x, point.y);
    by = "point";
  }
  const durationMs = "durationMs" in e && e.durationMs > 0 ? e.durationMs : undefined;
  return {
    id: `a${i + 1}`,
    kind,
    ...(e.sel ? { label: e.sel } : {}),
    tMs: e.tMs,
    ...(durationMs ? { endMs: e.tMs + durationMs } : {}),
    x: e.x,
    y: e.y,
    ...("to" in e && e.to ? { to: e.to } : {}),
    ...(e.box ? { box: e.box } : {}),
    ...(before ? { before } : {}),
    ...(e.state ? { after: e.state } : {}),
    ...(el && before
      ? {
          target: {
            state: before,
            id: el.id,
            ref: `${before}:${el.id}`,
            tag: el.tag,
            ...(el.role ? { role: el.role } : {}),
            label: labelOf(el),
            box: el.box,
            by,
          },
        }
      : {}),
    ...(e.effectBox ? { effectBox: e.effectBox } : {}),
    ...(e.changeCoverage != null ? { changeCoverage: e.changeCoverage } : {}),
    ...(e.kind === "type" ? { text: e.text } : {}),
    ...(e.kind === "press" ? { keys: e.keys } : {}),
    ...(e.kind === "scroll" ? { dy: e.dy } : {}),
    ...(e.kind === "dropFiles" ? { files: e.files.map((f) => f.name) } : {}),
    ...(e.caption ? { caption: e.caption } : {}),
    ...(e.note ? { note: e.note } : {}),
  };
}

// --- the take ------------------------------------------------------------------------

/** Everything `open-take states` prints, as data. `takeDir` is the take's
 *  working dir (`<name>.take/`). Throws when the take has no saved states. */
export function describeTake(takeDir: string): TakeStates {
  const dir = resolve(takeDir);
  const logPath = join(dir, "capture.json");
  let log: CaptureLog;
  try {
    log = JSON.parse(readFileSync(logPath, "utf8")) as CaptureLog;
  } catch (e) {
    throw new Error(
      (e as NodeJS.ErrnoException).code === "ENOENT"
        ? `no capture log at ${logPath} — not a take produced by \`make\` (or the wrong path)`
        : `unreadable capture log ${logPath}: ${(e as Error).message}`,
    );
  }
  const items = log.states?.items ?? [];
  if (!items.length)
    throw new Error(
      `${basename(dir)} has no saved states — re-record it with \`open-take make --states\` ` +
        `(the recording then also saves the page's structure after the warmup and after every step)`,
    );
  const statesDir = join(dir, log.states?.dir || "states");
  const loaded = new Map<string, Indexed | string>();
  for (const it of items) {
    const read = readStateIndex(join(statesDir, it.id));
    loaded.set(it.id, typeof read === "string" ? read : indexed(read));
  }
  const indexOf = (id: string | undefined): StateIndex | undefined => {
    const v = id ? loaded.get(id) : undefined;
    return typeof v === "object" ? v.index : undefined;
  };
  const actions = log.events.map((e, i) => describeAction(e, i, items, indexOf));
  const afterOf = new Map(actions.filter((x) => x.after).map((x) => [x.after!, x]));

  const page = log.viewport.w * log.viewport.h;
  const states: StateSummary[] = [];
  let ok = 0;
  const failed: string[] = [];
  const moving: string[] = [];
  const missing: string[] = [];
  items.forEach((it, k) => {
    const ix = loaded.get(it.id)!;
    const action = afterOf.get(it.id);
    const base: StateSummary = {
      id: it.id,
      tMs: it.tMs,
      ...(it.step != null ? { step: it.step } : {}),
      ...(action ? { after: action.id } : {}),
      status: "ok",
    };
    if (it.moving) {
      // nothing saved: the page was still moving here (by design, not a failure)
      states.push({ ...base, status: "moving" });
      moving.push(it.id);
      return;
    }
    if (typeof ix === "string") {
      states.push({ ...base, status: "missing", error: ix });
      missing.push(it.id);
      return;
    }
    const fidelity = ix.index.fidelity ?? it.fidelity;
    const status = fidelity && !fidelity.ok ? "failed" : "ok";
    if (status === "ok") ok++;
    else failed.push(it.id);
    // what changed since the last SAVED screen (a moving moment has none)
    let prev: (typeof loaded extends Map<string, infer V> ? V : never) | undefined;
    let prevId = "";
    for (let j = k - 1; j >= 0 && typeof prev !== "object"; j--) {
      prev = loaded.get(items[j]!.id);
      prevId = items[j]!.id;
    }
    const changes =
      typeof prev === "object" ? summarizeChanges(prev, ix, prevId, it.id) : undefined;
    states.push({
      ...base,
      status,
      ...(fidelity ? { fidelity } : {}),
      url: ix.index.url,
      title: ix.index.title,
      elements: ix.index.elements.length,
      regions: regionsOf(ix, it.id),
      ...(changes ? { changes } : {}),
      ...(action?.effectBox
        ? {
            pixels: {
              box: action.effectBox,
              ...(action.changeCoverage != null ? { coverage: action.changeCoverage } : {}),
              unexplained: pixelsUnexplained(action.effectBox, changes ?? [], page),
            },
          }
        : {}),
    });
  });
  const first = [...loaded.values()].find((v): v is Indexed => typeof v === "object");
  return {
    take: basename(dir),
    dir: statesDir,
    viewport: { ...log.viewport, ...(first ? { dpr: first.index.viewport.dpr } : {}) },
    fidelity: { ok, total: ok + failed.length, failed, moving, missing },
    actions,
    states,
  };
}

// --- one state's outline --------------------------------------------------------------

/** An interactive or text-bearing element — or a paint surface (canvas /
 *  video / iframe), which a film must take from the recording. */
export type OutlineLeaf = {
  ref: string;
  id: string;
  tag: string;
  role?: string;
  /** what it reads as (its accessible name, else its text) */
  label: string;
  /** the caption a viewer sees when the accessible name says something else
   *  (a button "Compare" titled "Nothing to compare yet") */
  visible?: string;
  box: Box;
  interactive?: true;
};

export type OutlineCard = {
  ref: string;
  id: string;
  tag: string;
  role?: string;
  box: Box;
  /** its visible texts */
  content: string;
  /** paint surfaces and images inside it ("18 img") */
  holds?: string;
  cards: OutlineCard[];
  leaves: OutlineLeaf[];
};

export type OutlineRegion = StateRegion & { cards: OutlineCard[]; leaves: OutlineLeaf[] };

export type StateOutline = {
  state: StateSummary;
  /** back to front */
  regions: OutlineRegion[];
  /** what sits outside every region (a fixed toast, a tooltip on <body>) */
  elsewhere?: { cards: OutlineCard[]; leaves: OutlineLeaf[] };
};

/** One state as a film would carve it: each region, the cards inside it, and
 *  under each the interactive and text-bearing elements with their boxes. */
export function outlineState(data: TakeStates, id: string): StateOutline {
  const state = data.states.find((s) => s.id === id);
  if (!state)
    throw new Error(
      `no state ${id} in ${data.take} — it has ${data.states.map((s) => s.id).join(", ")}`,
    );
  const read = readStateIndex(join(data.dir, id));
  if (typeof read === "string") throw new Error(read);
  const ix = indexed(read);
  const index = ix.index;
  const regionIds = new Set(index.layers);
  const ref = (e: StateElement) => `${id}:${e.id}`;

  // an element's nearest region, card and labelled ancestor
  const nearest = (
    e: StateElement,
    pick: (x: StateElement) => boolean,
  ): StateElement | undefined => {
    let cur = ix.byPath.get(parentKey(e));
    while (cur && cur !== e) {
      if (pick(cur)) return cur;
      const up = ix.byPath.get(parentKey(cur));
      if (!up || up === cur) break;
      cur = up;
    }
    return undefined;
  };
  const isCard = (e: StateElement) => ix.cards.has(e.id) && !regionIds.has(e.id);
  const isRegion = (e: StateElement) => regionIds.has(e.id);

  const cardNode = new Map<string, OutlineCard>();
  for (const e of index.elements)
    if (isCard(e))
      cardNode.set(e.id, {
        ref: ref(e),
        id: e.id,
        tag: e.tag,
        ...(e.role ? { role: e.role } : {}),
        box: e.box,
        content: joinTexts(contentOf(index, e.id)),
        ...(holdsOf(index, e.id) ? { holds: holdsOf(index, e.id) } : {}),
        cards: [],
        leaves: [],
      });
  const regions: OutlineRegion[] = [];
  const regionNode = new Map<string, OutlineRegion>();
  for (const r of regionsOf(ix, id)) {
    const node = { ...r, cards: [], leaves: [] };
    regions.push(node);
    regionNode.set(r.id, node);
  }
  const elsewhere = { cards: [] as OutlineCard[], leaves: [] as OutlineLeaf[] };
  const home = (e: StateElement): { cards: OutlineCard[]; leaves: OutlineLeaf[] } => {
    const card = nearest(e, isCard);
    if (card) return cardNode.get(card.id)!;
    const region = nearest(e, isRegion);
    return region ? regionNode.get(region.id)! : elsewhere;
  };
  for (const e of index.elements) {
    if (isRegion(e)) continue;
    if (isCard(e)) {
      home(e).cards.push(cardNode.get(e.id)!);
      continue;
    }
    const label = labelOf(e);
    const surface = PAINT_TAGS.has(e.tag);
    if (!e.interactive && !label && !surface) continue;
    if (!e.interactive && e.role === "img" && !surface) continue;
    // a bold number inside a labelled span reads as part of the span
    if (!e.interactive && label) {
      const above = nearest(e, (x) => !!labelOf(x) && !isCard(x) && !isRegion(x));
      if (above && labelOf(above).includes(label)) continue;
    }
    const text = e.text?.trim() ?? "";
    const visible = text && e.name && !e.name.includes(text) ? text : undefined;
    home(e).leaves.push({
      ref: ref(e),
      id: e.id,
      tag: e.tag,
      ...(e.role ? { role: e.role } : {}),
      label,
      ...(visible ? { visible } : {}),
      box: e.box,
      ...(e.interactive ? { interactive: true } : {}),
    });
  }
  // a wrapper card that only holds one card and nothing of its own says
  // nothing the inner one does not
  const hoist = (cards: OutlineCard[]): OutlineCard[] =>
    cards.map((c) => {
      const inner = hoist(c.cards);
      const only = inner[0];
      return only && inner.length === 1 && !c.leaves.length && !c.holds
        ? only
        : { ...c, cards: inner };
    });
  for (const r of regions) r.cards = hoist(r.cards);
  elsewhere.cards = hoist(elsewhere.cards);
  return {
    state,
    regions,
    ...(elsewhere.cards.length || elsewhere.leaves.length ? { elsewhere } : {}),
  };
}

const PAINT_TAGS = new Set(["canvas", "video", "iframe"]);

// --- text ----------------------------------------------------------------------------

const WIDTH = 100;
const secs = (ms: number): string => `${(ms / 1000).toFixed(2)}s`;
const boxStr = (b: Box): string => `[${b.map((v) => Math.round(v)).join(",")}]`;
const trunc = (s: string, n: number): string =>
  s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`;
const quote = (s: string, n: number): string => JSON.stringify(trunc(s, n));

/** `prefix` then `parts` flowed with " · ", continuation lines indented to
 *  the prefix. */
function flow(prefix: string, parts: string[]): string[] {
  const out: string[] = [];
  const indent = " ".repeat(prefix.length);
  let line = prefix;
  let empty = true;
  for (const p of parts) {
    if (!empty && line.length + 3 + p.length > WIDTH) {
      out.push(`${line} ·`);
      line = indent + p;
    } else line = empty ? line + p : `${line} · ${p}`;
    empty = false;
  }
  out.push(line);
  return out;
}

function motionText(from: Box, to: Box): string {
  const moved = !near(from[0], to[0]) || !near(from[1], to[1]);
  const dw = to[2] - from[2];
  const dh = to[3] - from[3];
  const resized = !near(dw, 0) || !near(dh, 0);
  if (moved) return `${resized ? "moved + resized" : "moved"} ${boxStr(from)} → ${boxStr(to)}`;
  if (near(dw, 0)) return `${dh > 0 ? "grew" : "shrank"} ${from[3]} → ${to[3]} px tall`;
  if (near(dh, 0)) return `${dw > 0 ? "grew" : "shrank"} ${from[2]} → ${to[2]} px wide`;
  return `resized ${boxStr(from)} → ${boxStr(to)}`;
}

function changeText(l: StateChangeLine): string {
  const card = l.card ? " card" : "";
  const box = boxStr(l.box);
  const motion = l.from ? motionText(l.from, l.box) : "";
  const content = l.content ? ` ${quote(l.content, 100)}` : "";
  switch (l.kind) {
    case "added":
      return l.count
        ? `+ ${l.count} ${l.tag} in ${l.ref} ${box}${content}`
        : `+ ${l.ref}${card} ${l.content ? "" : `${l.tag} `}${box}${content}`;
    case "removed":
      return l.count
        ? `- ${l.count} ${l.tag} from ${l.ref} ${box}${content}`
        : `- ${l.ref}${card} ${l.content ? "" : `${l.tag} `}${box}${content}`;
    case "replaced": {
      const tail = motion ? ` · ${motion}` : "";
      if (!l.was)
        return l.count
          ? `+ ${l.count} ${l.tag} in ${l.ref} ${box}${content}${tail}`
          : `+ ${l.ref}${card} ${box}${content}${tail}`;
      return `~ ${l.ref}${card} ${box} ${quote(l.was, 50)} → ${quote(l.content ?? "", 100)}${tail}`;
    }
    case "changed": {
      const parts: string[] = [];
      if (l.was != null)
        parts.push(
          l.visible
            ? `${quote(l.visible, 40)} named ${quote(l.was, 50)} → ${quote(l.content ?? "", 50)}`
            : `${quote(l.was, 50)} → ${quote(l.content ?? "", 60)}`,
        );
      if (motion) parts.push(motion);
      else parts.push(box);
      return `~ ${l.ref}${card} ${parts.join(" · ")}`;
    }
  }
}

function statusText(s: StateSummary): string {
  if (s.status === "missing") return `MISSING — ${s.error}`;
  if (s.status === "moving")
    return "MOVING — not saved: the page never went quiet here; use the recording";
  if (s.status === "failed")
    return `FIDELITY FAILED ${s.fidelity?.psnr.toFixed(1)} dB — use the recording here`;
  return "ok";
}

function stateHeading(s: StateSummary, first: boolean): string {
  const what = s.after
    ? `after ${s.after}`
    : first
      ? "start"
      : s.step != null
        ? `after step ${s.step + 1} (no action)`
        : "no action";
  return `${s.id.padEnd(3)} ${what} · ${secs(s.tMs)} · ${statusText(s)}`;
}

const regionSignature = (regions: StateRegion[]): string =>
  regions.map((r) => `${r.name}${boxStr(r.box)}`).join("|");

const holdsText = (holds: string | undefined): string => (holds ? ` (${holds})` : "");

function regionLines(regions: StateRegion[]): string[] {
  const parts = regions.map(
    (r) => `${r.id} ${r.name}${r.summary ? ` ${quote(r.summary, 36)}` : ""}${holdsText(r.holds)}`,
  );
  return flow("    regions  ", parts);
}

function actionText(x: ActionSummary): string {
  const label = x.label ? quote(x.label, 48) : "";
  let head: string;
  let prep = "on";
  switch (x.kind) {
    case "type":
      head = `type ${quote(x.text ?? "", 40)}`;
      prep = "into";
      break;
    case "press":
      head = `press ${x.keys ?? ""}${label ? ` (reveals ${label})` : ""}`;
      break;
    case "scroll":
      head = `scroll ${(x.dy ?? 0) < 0 ? "up" : "down"} ${Math.abs(x.dy ?? 0)}px`;
      break;
    case "dropFiles":
      head = `drop ${x.files?.join(", ") ?? ""}`;
      prep = "onto";
      break;
    case "drag":
      head = `drag ${label} → (${x.to?.x},${x.to?.y})`.replace("  ", " ");
      prep = "from";
      break;
    default:
      head = `${x.kind}${label ? ` ${label}` : ""}`;
  }
  const time = x.endMs ? `${secs(x.tMs)}–${secs(x.endMs)}` : secs(x.tMs);
  let target = "";
  if (x.target) {
    const t = x.target;
    const name = t.label && t.label !== x.label ? ` ${quote(t.label, 40)}` : "";
    const role = t.label ? "" : ` (${t.role ?? t.tag})`;
    target = ` · ${prep} ${t.ref}${name}${role}`;
  }
  return `${x.id.padEnd(3)} ${head} · ${time}${target}`;
}

export type FormatOpts = {
  /** outline this one state instead of the listing */
  state?: string;
};

/** The listing (or, with `state`, one state's outline) as text. */
export function formatTakeStates(data: TakeStates, opts: FormatOpts = {}): string {
  if (opts.state) return formatOutline(outlineState(data, opts.state));
  const cap = 8; // change lines per state before "… N more"
  const n = data.states.length;
  const { ok, total, failed, moving, missing } = data.fidelity;
  const saved = n - moving.length;
  const out: string[] = [
    `${data.take} — ${saved} saved state${saved === 1 ? "" : "s"} · page ${data.viewport.w}×${data.viewport.h} CSS px · ` +
      `fidelity ${ok}/${total} ok${failed.length ? ` (${failed.join(", ")} FAILED)` : ""}` +
      (moving.length ? ` · ${moving.join(", ")} moving, not saved` : "") +
      (missing.length ? ` · ${missing.join(", ")} missing` : ""),
    `ids are per state: name an element together with its state (s3:e32) · --state <id> outlines one state`,
    "",
  ];
  // actions sit between the state they act on and the state they produce
  const timeline: ({ at: number; state: StateSummary } | { at: number; action: ActionSummary })[] =
    [
      ...data.states.map((state) => ({ at: state.tMs, state })),
      ...data.actions.map((action) => ({ at: action.tMs, action })),
    ];
  timeline.sort((p, q) => p.at - q.at || ("action" in p ? -1 : 1));
  let lastRegions: string | undefined;
  let lastPage: string | undefined;
  let first = true;
  for (const entry of timeline) {
    if ("action" in entry) {
      out.push(actionText(entry.action));
      continue;
    }
    const s = entry.state;
    out.push(stateHeading(s, first));
    first = false;
    if (s.status === "missing") continue;
    const page = `${s.url ?? ""} ${s.title ? quote(s.title, 60) : ""}`.trim();
    if (page && page !== lastPage) {
      out.push(`    page  ${page}`);
      lastPage = page;
    }
    if (s.regions?.length) {
      const sig = regionSignature(s.regions);
      if (sig !== lastRegions) {
        out.push(...regionLines(s.regions));
        lastRegions = sig;
      }
    }
    const changes = s.changes ?? [];
    const shown = [...changes]
      .map((c, i) => ({ c, i }))
      .sort((p, q) => p.c.priority - q.c.priority || p.i - q.i)
      .slice(0, cap)
      .sort((p, q) => p.i - q.i)
      .map((x) => x.c);
    for (const c of shown) out.push(`    ${changeText(c)}`);
    if (changes.length > shown.length) out.push(`    … ${changes.length - shown.length} more`);
    if (s.pixels)
      out.push(
        `    pixels  ${boxStr(toBox(s.pixels.box))}${
          s.pixels.unexplained
            ? " — no element changed there: a paint or style change, only the recording shows it"
            : ""
        }`,
      );
    else if (!changes.length && s.changes) out.push("    no change");
  }
  return out.join("\n");
}

function leafText(l: OutlineLeaf): string {
  const role = l.role && l.role !== "img" ? l.role : l.interactive || !l.label ? l.tag : undefined;
  const label = l.visible
    ? ` ${quote(l.visible, 24)} named ${quote(l.label, 40)}`
    : l.label
      ? ` ${quote(l.label, 40)}`
      : "";
  return `${l.id}${role ? ` ${role}` : ""}${label} ${boxStr(l.box)}`;
}

const LEAF_CAP = 12;
const CARD_CAP = 8;

function outlineLines(
  node: { cards: OutlineCard[]; leaves: OutlineLeaf[] },
  depth: number,
  out: string[],
): void {
  const indent = " ".repeat(depth * 2 + 5);
  // document order (ids number the elements in it), runs of leaves flowed together
  const num = (id: string) => Number(id.slice(1));
  const cards = node.cards.slice(0, CARD_CAP);
  const leaves = node.leaves.slice(0, LEAF_CAP);
  const items = [
    ...cards.map((c) => ({ at: num(c.id), card: c })),
    ...leaves.map((l) => ({ at: num(l.id), leaf: l })),
  ].sort((p, q) => p.at - q.at);
  let run: string[] = [];
  const flush = () => {
    if (run.length) out.push(...flow(indent, run));
    run = [];
  };
  for (const item of items) {
    if ("leaf" in item) {
      run.push(leafText(item.leaf));
      continue;
    }
    flush();
    const c = item.card;
    const role = c.role && c.role !== "img" ? `${c.role} ` : "";
    out.push(
      `${indent}card ${c.id} ${role}${boxStr(c.box)}${c.content ? ` ${quote(c.content, 90)}` : ""}${holdsText(c.holds)}`,
    );
    outlineLines(c, depth + 1, out);
  }
  if (node.leaves.length > LEAF_CAP) run.push(`… ${node.leaves.length - LEAF_CAP} more`);
  flush();
  if (node.cards.length > CARD_CAP)
    out.push(`${indent}… ${node.cards.length - CARD_CAP} more cards`);
}

function formatOutline(o: StateOutline): string {
  const s = o.state;
  const out: string[] = [
    `${stateHeading(s, s.id === "s0")} · ${s.elements ?? 0} elements` +
      `${s.title ? ` · ${quote(s.title, 60)}` : ""}${s.url ? ` ${s.url}` : ""}`,
    `regions back → front · card = a group a film might show on its own (≥2 labels, 0.3–20% of the page) · name elements as ${s.id}:e<N>`,
    "",
  ];
  for (const r of o.regions) {
    out.push(
      `${r.id.padEnd(4)} ${r.name} ${boxStr(r.box)}${r.summary ? `  ${quote(r.summary, 80)}` : ""}${holdsText(r.holds)}`,
    );
    outlineLines(r, 0, out);
  }
  if (o.elsewhere) {
    out.push("—    outside every region");
    outlineLines(o.elsewhere, 0, out);
  }
  return out.join("\n");
}
