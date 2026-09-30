// What changed between two saved states of one page (`make --states`): the
// same element found in both (element ids are per state), and what happened
// to it — its text, its box — or that it appeared or went. Recipes use it to
// find an element again after an action and to keep a lifted element clear
// of what the action changed; `open-take states` uses it to tell the model
// what each action did.

import type { StateElement, StateIndex } from "./state-index";

type Box = [number, number, number, number];

/** What an element reads as: its accessible name, else its own text. */
export const elementLabel = (e: StateElement): string => e.name ?? e.text ?? "";

function iou(a: Box, b: Box): number {
  const x0 = Math.max(a[0], b[0]),
    y0 = Math.max(a[1], b[1]),
    x1 = Math.min(a[0] + a[2], b[0] + b[2]),
    y1 = Math.min(a[1] + a[3], b[1] + b[3]);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const union = a[2] * a[3] + b[2] * b[3] - inter;
  return union > 0 ? inter / union : 0;
}

/** Pairs `a` element id → `b` element id: first the element the DOM kept in
 *  place (same path and tag — unless it reads differently AND sits somewhere
 *  else, which is a different element that took the slot), then a unique
 *  (tag, role, label) among the rest, then the same tag overlapping most. */
export function matchStates(a: StateIndex, b: StateIndex): Map<string, string> {
  const pairs = new Map<string, string>();
  const taken = new Set<string>();
  const pair = (ea: StateElement, eb: StateElement) => {
    pairs.set(ea.id, eb.id);
    taken.add(eb.id);
  };
  const byPath = new Map(b.elements.map((e) => [e.path.join("."), e]));
  const aByPath = new Map(a.elements.map((e) => [e.path.join("."), e]));
  const bById = new Map(b.elements.map((e) => [e.id, e]));
  const shift = (ea: StateElement, eb: StateElement) => [
    eb.box[0] - ea.box[0],
    eb.box[1] - ea.box[1],
  ];
  for (const ea of a.elements) {
    const eb = byPath.get(ea.path.join("."));
    if (!eb || eb.tag !== ea.tag) continue;
    // an element riding along with its (matched) parent is the same element,
    // whatever it now reads — a badge whose box moved with it
    const parentA = aByPath.get(ea.path.slice(0, -1).join("."));
    const parentB =
      parentA && pairs.has(parentA.id) ? bById.get(pairs.get(parentA.id)!) : undefined;
    const rode =
      parentA !== undefined &&
      parentB !== undefined &&
      shift(parentA, parentB).every((d, i) => Math.abs(d - shift(ea, eb)[i]!) <= 3);
    const overlap = iou(ea.box, eb.box);
    if (!rode) {
      // a relabelled element somewhere else is a different element in the slot
      if (elementLabel(ea) !== elementLabel(eb) && overlap < 0.1) continue;
      // an unlabelled container is the same one only if it stayed roughly in
      // place or kept some of what it showed (a bare leaf — a playhead line —
      // is the same element wherever it went)
      if (
        !elementLabel(ea) &&
        !elementLabel(eb) &&
        overlap < 0.3 &&
        subtree(a, ea.id).length > 1 &&
        !sharesContent(a, ea, b, eb)
      )
        continue;
    }
    pair(ea, eb);
  }
  const sig = (e: StateElement) => `${e.tag}|${e.role ?? ""}|${elementLabel(e)}`;
  const count = (list: StateElement[]) => {
    const n = new Map<string, number>();
    for (const e of list) n.set(sig(e), (n.get(sig(e)) ?? 0) + 1);
    return n;
  };
  let restA = a.elements.filter((e) => !pairs.has(e.id));
  let restB = b.elements.filter((e) => !taken.has(e.id));
  const na = count(restA),
    nb = count(restB);
  const unique = new Map(restB.filter((e) => nb.get(sig(e)) === 1).map((e) => [sig(e), e]));
  for (const ea of restA) {
    if (!elementLabel(ea) || na.get(sig(ea)) !== 1) continue;
    const eb = unique.get(sig(ea));
    if (eb) pair(ea, eb);
  }
  restA = a.elements.filter((e) => !pairs.has(e.id));
  restB = b.elements.filter((e) => !taken.has(e.id));
  const candidates: [number, StateElement, StateElement][] = [];
  for (const ea of restA)
    for (const eb of restB)
      if (ea.tag === eb.tag) {
        const o = iou(ea.box, eb.box);
        if (o >= 0.5) candidates.push([o, ea, eb]);
      }
  candidates.sort((x, y) => y[0] - x[0]);
  for (const [, ea, eb] of candidates) if (!pairs.has(ea.id) && !taken.has(eb.id)) pair(ea, eb);
  return pairs;
}

export type StateChange =
  | { kind: "added"; b: StateElement }
  | { kind: "removed"; a: StateElement }
  | {
      kind: "changed";
      a: StateElement;
      b: StateElement;
      text: boolean;
      moved: boolean;
      resized: boolean;
    };

/** Everything that differs between two states, in `b`'s document order
 *  (removals last). A box change under 3 px is layout noise, not a change. */
export function diffStates(a: StateIndex, b: StateIndex): StateChange[] {
  const pairs = matchStates(a, b);
  const back = new Map([...pairs].map(([ia, ib]) => [ib, ia]));
  const byId = new Map(a.elements.map((e) => [e.id, e]));
  const out: StateChange[] = [];
  for (const eb of b.elements) {
    const ia = back.get(eb.id);
    if (!ia) {
      out.push({ kind: "added", b: eb });
      continue;
    }
    const ea = byId.get(ia)!;
    const text = elementLabel(ea) !== elementLabel(eb);
    const moved = Math.abs(ea.box[0] - eb.box[0]) > 2 || Math.abs(ea.box[1] - eb.box[1]) > 2;
    const resized = Math.abs(ea.box[2] - eb.box[2]) > 2 || Math.abs(ea.box[3] - eb.box[3]) > 2;
    if (text || moved || resized) out.push({ kind: "changed", a: ea, b: eb, text, moved, resized });
  }
  for (const ea of a.elements) if (!pairs.has(ea.id)) out.push({ kind: "removed", a: ea });
  return out;
}

/** The element and everything inside it (by path). */
export function subtree(index: StateIndex, id: string): StateElement[] {
  const root = index.elements.find((e) => e.id === id);
  if (!root) return [];
  const p = root.path;
  return index.elements.filter(
    (e) => e.path.length >= p.length && p.every((v, i) => e.path[i] === v),
  );
}

/** What an element shows: its own text, or its name when the name is that
 *  text in full (a span whose text is split by inline children reads whole),
 *  or its name alone when it has no text (an icon button's label) — never a
 *  tooltip over visible text. */
export function visibleLabel(e: StateElement): string {
  const text = (e.text ?? "").trim(),
    name = (e.name ?? "").trim();
  if (text && inOrder(text, name)) return name;
  return text || name;
}

/** Every word of `part` appears in `whole`, in order (the text around an
 *  inline child — "click a | in the timeline" — against the whole sentence).
 *  Labels are capped at 80 characters by the probe: a capped `part` may end
 *  mid-word, and a capped `whole` may simply stop early. */
function inOrder(part: string, whole: string): boolean {
  const capped = (label: string) => label.length >= 79;
  const words = whole.split(/\s+/);
  const need = part.split(/\s+/);
  if (capped(part)) need.pop();
  let at = 0;
  for (const w of need) {
    while (at < words.length && words[at] !== w) at++;
    if (at >= words.length) return capped(whole);
    at++;
  }
  return true;
}

/** What an element shows with everything inside it, in document order:
 *  each element's visible label, leaving out a label that an element already
 *  read contains (the pieces of a sentence read once). */
export function contentOf(index: StateIndex, id: string): string[] {
  const out: string[] = [];
  for (const e of subtree(index, id)) {
    const label = visibleLabel(e);
    if (!label || out.some((l) => l.includes(label))) continue;
    out.push(label);
  }
  return out;
}

function sharesContent(a: StateIndex, ea: StateElement, b: StateIndex, eb: StateElement): boolean {
  const mine = new Set(contentOf(a, ea.id));
  return mine.size > 0 && contentOf(b, eb.id).some((l) => mine.has(l));
}

/** Where on the page an action changed something (boxes in `b`), leaving
 *  out one element's own subtree — the element being shown on its own. */
export function changedBoxes(a: StateIndex, b: StateIndex, except?: string): Box[] {
  const inside = new Set(except ? subtree(a, except).map((e) => e.id) : []);
  const insideB = new Set<string>();
  if (except) {
    const pairs = matchStates(a, b);
    const mine = pairs.get(except);
    if (mine) for (const e of subtree(b, mine)) insideB.add(e.id);
  }
  const boxes: Box[] = [];
  for (const c of diffStates(a, b)) {
    if (c.kind === "removed") {
      if (!inside.has(c.a.id)) boxes.push(c.a.box);
    } else if (!insideB.has(c.b.id)) {
      boxes.push(c.b.box);
      if (c.kind === "changed" && (c.moved || c.resized)) boxes.push(c.a.box);
    }
  }
  return boxes;
}
