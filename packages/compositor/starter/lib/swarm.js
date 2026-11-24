// swarm.js — a team of agent cursors building a finished screen in front of
// the viewer: each flies in, drags a selection box with corner handles round
// a card and the card appears, types a line of copy in with a text cursor,
// draws a rule, wipes in a picture, copies a repeated label from where it
// already stands, until the real screen stands untouched. A style some launch
// films use for "many agents working at once"; not a default for every film.
//
// The idea is swarm-animation (github.com/thefullctx/swarm-animation, MIT): a
// script that plays over a live web page on the browser's own clock and
// random numbers. Written again here as plain functions of film time, with no
// code taken from it; the ways of hiding a thing without moving the layout
// are its: a text node holds what is typed and an invisible twin beside it
// the rest, a box's paint is taken off and put back, a picture is wiped in.
// Under `film render` the original runs in clock mode — the same frames on
// any number of workers, but front to back only and with no motion blur, and
// with no start time, labels, holds or events to set sound and camera on.
//
// Plain functions of film time t (s): the plan is made once from the seed and
// the layout, and `draw(t)` writes the screen as it is at t — the same t
// gives the same frame in any order, so a render split across workers agrees.
// No timers, no Math.random.
//
//   import { swarm, swarmBoxes } from "./lib/swarm.js";
//   await document.fonts.ready;                    // the layout is read once, after the fonts
//   const sw = swarm(document.querySelector("#table"), {
//     agents: 8, seed: 1, start: 2.0, duration: 6, // or speed (1: about 22 characters a second)
//     labels: ["競品 A", "競品 B", …], colors: ["#7cc4ff", …],
//     assign: (item) => item.el.closest("tr")?.rowIndex - 1,   // or "nearest"; or data-swarm-agent="3"
//     holds: [{ agent: 5, from: 4.2, to: 6.0, color: "#fbbf24", label: "競品 F · 需要你" }],
//   });
//   window.__render = (t) => { camera(t); sw.draw(t); };   // after the camera: constantSize reads it
//   sw.events.forEach((e) => e.kind === "done" && tl.event(e.t, "tick"));
//
//   swarm(root, o)              the elements inside root built by o.agents cursors; the overlay is put
//                               inside root, so a root that is scaled, moved or tilted in CSS
//                               perspective carries the cursors with it
//   swarmBoxes(el, boxes, o)    the same over a picture (<img>, <video>, <canvas>): each box
//                               { x, y, w, h, kind?, label?, agent?, order? } is revealed through a
//                               mask of its own; boxes in the picture's own px, or in o.size [w, h]
//                               (a shoot's boxes are in the still's CSS px: size: [1440, 900]); a
//                               box inside another is covered in the colour sampled round it until
//                               its own agent builds it, so a card shows empty, not with its rows
//   plan(items, o)              the schedule alone, no page: what tests and a sound script read
//
//   each gives back { el, draw(t), end, events, items, agentsAt(t) }:
//     draw(t)       the screen at t: before o.start everything is hidden (the root's own
//                   background stays), after the last cursor leaves the page is as it was
//     end           when the last item lands
//     events        [{ t, agent, kind, el, item }] by time: kind "box", "type", "line", "wipe",
//                   "copy" when an item's work starts, "done" when it lands, "hold" and
//                   "resume" — for hits in the score and camera moves
//     items         [{ el, kind, agent, arrive, start, end, rect }] in plan order
//     agentsAt(t)   [{ x, y, visible, label, color, state }] in root px (its border box's top
//                   left); state "enter", "travel", "wait", "type", "box", "line", "wipe",
//                   "copy", "hold", "leave", "park", "gone"
//
// Options (swarm and swarmBoxes):
//   agents 8, seed 1, start 0     how many, which numbers, when the first one enters
//   duration | speed              duration: start → end, the speed fitted to it (holds included);
//                                 else speed (1)
//   labels, colors                per agent: its tag (none: a bare cursor) and colour (default eight
//                                 hues apart, light enough for a dark surface)
//   assign                        "nearest" (default: the free agent takes the nearest of the
//                                 next few things in reading order) or (item, i) => agent index
//                                 (null: nearest); data-swarm-agent on an element or an ancestor
//                                 wins over both. An agent with its own items still helps with
//                                 shared ones that come before them in reading order (a header)
//   holds                         [{ agent, from, to, color?, label? }]: that agent stops where it
//                                 is — mid-travel or mid-word — and waits, its cursor, tag and
//                                 selection in the hold's colour with the hold's label, a ring
//                                 pulsing round the tip; it carries on at `to` from where it was
//   from                          [{ x, y }, …] in root px: where agents enter (cycled); default
//                                 from outside the root's nearest edge to each agent's first item
//   exit                          "leave" (default: out past the nearest edge) or "park": stay where
//                                 the last item was left, until `out` (s) if given
//   lift                          px the cursors float above the surface (translateZ): on a root
//                                 tilted in perspective they move against it as the camera moves;
//                                 sets transform-style: preserve-3d on the root, which must be the
//                                 tilted element (or keep preserve-3d down to it)
//   constantSize                  true: cursors, tags, handles and badges keep their size on screen
//                                 when a camera scales the root (read each draw from the root's
//                                 box on screen); false: they scale with the surface
//   copies                        true: a short label repeated 3+ times (a status, a tag) is carried
//                                 over from the nearest place it has already landed, when there is
//                                 one by the time its agent comes to it; else it is typed
//   guides                        true: a faint guide line drops from some boxes as they start
//   font                          the tags' font
//
// In the root: data-swarm-skip (left alone, children too), data-swarm="media" (wiped in as one
// picture) or "box" (built as a card), data-swarm-agent="3", data-swarm-order="2" (an explicit
// order: items sort by it, then by reading order; the same number for a whole stage). What is
// found: text (typed), elements with a background, a shadow or two or more borders (boxes), a
// thin element or one with a single border (rules: drawn), img / svg / canvas / video / iframe /
// input (media: dragged, then wiped down). Nothing is hidden with display: text is split
// between the text node and an invisible twin (in a flex or grid parent, both in one inline
// wrapper), a box loses its paint with !important, media takes opacity and clip-path — the
// layout does not move. Transitions are held off on the items while they are being built.
//
// The layout is read once, on the first call, with the transforms of the root and everything
// above it set aside — so a root already under a camera or a tilt is read flat, in its own px.
// What changes layout after that (a font arriving late, text the film changes) is not followed:
// build after `await document.fonts.ready` and leave the built elements' layout alone. A root
// with overflow: hidden clips the cursors that enter from outside it.
//
// Nothing here blurs: the cursors are elements moved by transform, which `film render`
// measures like any other, so a fast flight is smeared by the master's shutter and a landing is
// sharp. A draft has no shutter — `film still --at` shows a frame as the master will.
//
// On lib/space.js: a slab is a live element, so swarm(slabEl) builds inside it and the stage
// redraws its texture as it changes — every frame while cursors move, which costs a slab's
// re-rasterising at its `scale` per frame; `lift` and `constantSize` do nothing there (the
// overlay is part of the picture on the slab). Not tried under a render.

import { clamp, ease, lerp, rng } from "./anim.js";

/** @typedef {[number, number]} Pt */
/** @typedef {{ x: number, y: number, w: number, h: number }} Rect */
/** @typedef {"text" | "box" | "rule" | "media" | "copy"} Kind */
/**
 * One thing an agent builds, as the plan reads it (coordinates in the overlay's px).
 * @typedef {object} PlanItem
 * @property {Kind} kind
 * @property {Rect} rect
 * @property {Pt[]} [path]    text: the caret before the first character and after each; rule: its two ends
 * @property {Rect} [src]     copy: where the original stands
 * @property {number} [agent] the agent it is given to; none: the nearest free one
 * @property {number} [order] sorts before reading order (default 0)
 * @property {number} [after] an item that must land before this one starts
 * @property {number} [copyOf] the item this one copies (lands first)
 * @property {number} [group]  text: one of a repeated label; copied from a landed one when there is one
 * @property {number} [work]  seconds of work at speed 1 (default from its kind and size)
 */
/** @typedef {{ agent: number, from: number, to: number, color?: string, label?: string }} Hold */
/**
 * @typedef {object} PlanOptions
 * @property {number} [agents]
 * @property {number} [seed]
 * @property {number} [start]
 * @property {number} [duration]
 * @property {number} [speed]
 * @property {Hold[]} [holds]
 * @property {{ x: number, y: number }[]} [from]  entry points, in the plan's px
 * @property {"leave" | "park"} [exit]
 * @property {number} [out]   parked agents leave the picture at this time
 * @property {Rect} [bounds]  what "outside" means for entering and leaving (default: round the items)
 * @property {number} [stagger] s between agents entering (0.07)
 */
/** @typedef {"travel" | "wait" | "work" | "leave" | "park"} SegKind */
/** @typedef {{ kind: SegKind, t0: number, t1: number, dur: number, from: Pt, to: Pt, item: number, bow: number }} Seg */
/** @typedef {{ agent: number, arrive: number, start: number, end: number, work: number, set: number }} Slot */
/** @typedef {{ t: number, agent: number, kind: string, item: number }} PlanEvent */
/** @typedef {{ x: number, y: number, state: string, seg: SegKind, item: number, p: number, alpha: number, held: Hold | null }} AgentAt */

/** a[i], known to be there @template T @param {T[]} a @param {number} i @returns {T} */
const nth = (a, i) => /** @type {T} */ (a[i]);
const FADE = 0.22; // s a finished item's selection takes to fade
const VERB = /** @type {Record<Kind, string>} */ ({ text: "type", box: "box", rule: "line", media: "wipe", copy: "copy" });

/** seconds of work for an item at speed 1 @param {PlanItem} it */
export function workOf(it) {
  if (it.work != null) return it.work;
  const { w, h } = it.rect;
  const size = clamp(Math.sqrt(Math.max(0, w * h)) / 400);
  if (it.kind === "text") return clamp(0.25 + ((it.path?.length ?? 9) - 1) * 0.045, 0.35, 2);
  if (it.kind === "rule") return 0.3 + 0.3 * clamp(Math.max(w, h) / 800);
  if (it.kind === "media") return 0.7 + 0.5 * size;
  if (it.kind === "copy") return 0.7;
  return 0.45 + 0.35 * size;
}

/** seconds a cursor takes to cross `d` px at speed 1: short hops quick, long flights not much longer @param {number} d */
const travelOf = (d) => 0.25 + 0.55 * Math.sqrt(d / 1000);

const centre = (/** @type {Rect} */ r) => /** @type {Pt} */ ([r.x + r.w / 2, r.y + r.h / 2]);

/**
 * Where the cursor is while an item is p (0..1) of the way built: a box's
 * dragging corner, the caret of a text, a rule's tip, a copy in flight.
 * @param {PlanItem} it @param {number} p @returns {Pt}
 */
export function workPoint(it, p) {
  const r = it.rect;
  const u = clamp(p);
  if (it.kind === "text") {
    /** @type {Pt[]} */
    const path = it.path?.length ? it.path : [[r.x, r.y + r.h / 2], [r.x + r.w, r.y + r.h / 2]];
    const f = u * (path.length - 1);
    const i = Math.floor(f);
    const a = nth(path, i);
    const b = path[Math.min(path.length - 1, i + 1)] ?? a;
    return [lerp(a[0], b[0], f - i), lerp(a[1], b[1], f - i)];
  }
  if (it.kind === "rule") {
    /** @type {Pt[]} */
    const path = it.path ?? [[r.x, r.y], [r.x + r.w, r.y]];
    const a = nth(path, 0);
    const b = path[path.length - 1] ?? a;
    const q = ease.inOut3(u);
    return [lerp(a[0], b[0], q), lerp(a[1], b[1], q)];
  }
  if (it.kind === "copy") {
    const from = centre(it.src ?? r);
    const to = centre(r);
    const q = ease.inOut3(clamp(u / 0.5));
    return [lerp(from[0], to[0], q), lerp(from[1], to[1], q)];
  }
  const q = ease.out3(clamp(u / (it.kind === "media" ? 0.33 : 0.55)));
  return [r.x + r.w * q, r.y + r.h * q];
}

/** the end of `dur` s of an agent's work begun at t, its holds skipped @param {Hold[]} hs @param {number} t @param {number} dur */
function advance(hs, t, dur) {
  let at = t;
  let left = dur;
  for (const h of hs) {
    if (h.to <= at) continue;
    if (h.from >= at + left && !(left === 0 && h.from <= at)) break;
    if (h.from > at) left -= h.from - at;
    at = Math.max(at, h.to);
  }
  return at + left;
}

/** an agent's working time between t0 and t: the time its holds took left out @param {Hold[]} hs @param {number} t0 @param {number} t */
function workBetween(hs, t0, t) {
  if (t <= t0) return 0;
  let w = t - t0;
  for (const h of hs) w -= Math.max(0, Math.min(t, h.to) - Math.max(t0, h.from));
  return w;
}

/** the union of rects @param {Rect[]} rs @returns {Rect} */
function union(rs) {
  if (!rs.length) return { x: 0, y: 0, w: 0, h: 0 };
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of rs) {
    x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** the point just outside `b`'s edge nearest to p, `m` px out, slid along it by `slide` @param {Rect} b @param {Pt} p @param {number} m @param {number} slide @returns {Pt} */
function outside(b, p, m, slide) {
  const d = [p[0] - b.x, b.x + b.w - p[0], p[1] - b.y, b.y + b.h - p[1]];
  const k = d.indexOf(Math.min(...d));
  if (k === 0) return [b.x - m, p[1] + slide];
  if (k === 1) return [b.x + b.w + m, p[1] + slide];
  if (k === 2) return [p[0] + slide, b.y - m];
  return [p[0] + slide, b.y + b.h + m];
}

/**
 * The schedule, with no page: which agent builds which item, when it arrives,
 * starts and lands, where every cursor is at any t. Pure: the same items and
 * options give the same plan.
 * @param {PlanItem[]} items @param {PlanOptions} [o]
 */
export function plan(items, o = {}) {
  const n = Math.max(1, Math.round(o.agents ?? 8));
  const start = o.start ?? 0;
  /** @type {Hold[][]} */
  const holdsOf = Array.from({ length: n }, () => []);
  for (const h of o.holds ?? []) if (h.to > h.from) nth(holdsOf, ((h.agent % n) + n) % n).push(h);
  for (const hs of holdsOf) hs.sort((a, b) => a.from - b.from);
  let speed = o.speed ?? 1;
  if (o.duration && o.duration > 0 && items.length) {
    let lo = 0.01, hi = 100;
    for (let k = 0; k < 48; k++) {
      const mid = Math.sqrt(lo * hi);
      if (simulate(items, o, n, start, mid, holdsOf).end - start > o.duration) lo = mid;
      else hi = mid;
    }
    speed = hi;
  }
  const s = simulate(items, o, n, start, speed, holdsOf);
  /** @type {PlanEvent[]} */
  const events = [];
  s.slots.forEach((sl, i) => {
    const it = nth(s.items, i);
    events.push({ t: sl.start, agent: sl.agent, kind: VERB[it.kind], item: i });
    events.push({ t: sl.end, agent: sl.agent, kind: "done", item: i });
  });
  holdsOf.forEach((hs, a) => {
    for (const h of hs) {
      events.push({ t: h.from, agent: a, kind: "hold", item: -1 });
      events.push({ t: h.to, agent: a, kind: "resume", item: -1 });
    }
  });
  events.sort((a, b) => a.t - b.t || a.agent - b.agent || (a.kind === "done" ? -1 : 0) - (b.kind === "done" ? -1 : 0));

  /** where agent a is at t, null when it is not in the picture @param {number} a @param {number} t @returns {AgentAt | null} */
  const agentAt = (a, t) => {
    const segs = nth(s.segs, a);
    const hs = nth(holdsOf, a);
    const first = segs[0];
    const last = segs[segs.length - 1];
    if (!first || !last || t < first.t0 || t >= last.t1) return null;
    let k = 0;
    while (k < segs.length - 1 && t >= nth(segs, k).t1) k++;
    const sg = nth(segs, k);
    const held = hs.find((h) => t >= h.from && t < h.to) ?? null;
    let x = sg.to[0], y = sg.to[1], p = 0;
    let state = sg.kind === "park" ? "park" : sg.kind === "wait" ? "wait" : sg.kind;
    if (sg.kind === "travel" || sg.kind === "leave") {
      const u = sg.dur > 0 ? clamp(workBetween(hs, sg.t0, t) / sg.dur) : 1;
      const e = ease.inOut3(u);
      const dx = sg.to[0] - sg.from[0], dy = sg.to[1] - sg.from[1];
      const bend = sg.bow * Math.sin(Math.PI * e);
      x = lerp(sg.from[0], sg.to[0], e) - dy * bend;
      y = lerp(sg.from[1], sg.to[1], e) + dx * bend;
      if (sg.kind === "travel" && k === 0) state = "enter";
    } else if (sg.kind === "work") {
      p = sg.dur > 0 ? clamp(workBetween(hs, sg.t0, t) / sg.dur) : 1;
      [x, y] = workPoint(nth(s.items, sg.item), p);
      state = VERB[nth(s.items, sg.item).kind];
    }
    if (held) state = "hold";
    let alpha = clamp((t - first.t0) / 0.12);
    if (last.kind === "leave") alpha *= clamp((last.t1 - t) / 0.15);
    return { x, y, state, seg: sg.kind, item: sg.item, p, alpha, held };
  };

  /** an item at t: 0 not begun, 1 being built (p), 2 landed @param {number} i @param {number} t */
  const itemAt = (i, t) => {
    const sl = s.slots[i];
    if (!sl) return { phase: 2, p: 1 };
    if (t < sl.start) return { phase: 0, p: 0 };
    if (t >= sl.end) return { phase: 2, p: 1 };
    return { phase: 1, p: sl.work > 0 ? clamp(workBetween(nth(holdsOf, sl.agent), sl.start, t) / sl.work) : 1 };
  };

  return {
    n, start, speed, end: s.end, gone: s.gone, slots: s.slots, segs: s.segs, holds: holdsOf, events, bounds: s.bounds, items: s.items,
    agentAt, itemAt,
  };
}

/**
 * One run of the schedule at a speed.
 * @param {PlanItem[]} items @param {PlanOptions} o @param {number} n @param {number} start @param {number} speed @param {Hold[][]} holdsOf
 */
function simulate(items, o, n, start, speed, holdsOf) {
  const r = rng((o.seed ?? 1) * 7919 + 17);
  const bounds = o.bounds ?? union(items.map((it) => it.rect));
  /** @type {PlanItem[]} */
  const res = items.map((it) => ({ ...it }));
  /** @type {(Slot | undefined)[]} */
  const slots = items.map(() => undefined);
  const rank = (/** @type {number} */ i) => nth(items, i).order ?? 0;
  const before = (/** @type {number} */ i, /** @type {number} */ j) => rank(i) - rank(j) || i - j;
  /** @type {number[][]} */
  const queues = Array.from({ length: n }, () => []);
  /** @type {number[]} */
  let pool = [];
  items.forEach((it, i) => {
    if (it.agent != null && Number.isFinite(it.agent) && it.agent >= 0) nth(queues, Math.floor(it.agent) % n).push(i);
    else pool.push(i);
  });
  for (const q of queues) q.sort(before);
  pool.sort(before);
  const deps = (/** @type {number} */ i) => {
    const it = nth(items, i);
    return [it.after, it.copyOf].filter((d) => d != null && d >= 0 && d < items.length && d !== i);
  };
  /** @type {Set<number>} */
  const broken = new Set();
  const ready = (/** @type {number} */ i) => broken.has(i) || deps(i).every((d) => slots[/** @type {number} */ (d)]);
  const depEnd = (/** @type {number} */ i) =>
    broken.has(i) ? -Infinity : Math.max(-Infinity, ...deps(i).map((d) => slots[/** @type {number} */ (d)]?.end ?? -Infinity));
  const stagger = o.stagger ?? 0.07;
  const agents = Array.from({ length: n }, (_, a) => {
    const t = start + a * stagger + r() * 0.06;
    const firstItem = nth(queues, a)[0] ?? pool[Math.min(pool.length - 1, a)];
    const given = o.from?.length ? nth(o.from, a % o.from.length) : null;
    /** @type {Pt} */
    let pos;
    if (given) pos = [given.x, given.y];
    else if (firstItem != null) pos = outside(bounds, workPoint(nth(items, firstItem), 0), 70 + r() * 40, (r() - 0.5) * 80);
    else pos = [bounds.x - 80, bounds.y + bounds.h * r()];
    /** @type {Seg[]} */
    const segs = [];
    return { a, free: t, pos, segs, done: false, k: 0 };
  });
  const K = 6;
  /** the nearest of the candidates, with a little chance in it @param {{ pos: Pt, free: number }} ag @param {number[]} cands */
  const nearest = (ag, cands) => {
    let best = nth(cands, 0), bestScore = Infinity;
    for (const i of cands) {
      const p = workPoint(nth(items, i), 0);
      const d = Math.hypot(p[0] - ag.pos[0], p[1] - ag.pos[1]);
      const late = Math.max(0, depEnd(i) - (ag.free + travelOf(d) / speed));
      const score = d * (0.7 + 0.6 * r()) + late * 800;
      if (score < bestScore) { bestScore = score; best = i; }
    }
    return best;
  };
  /** -2: nothing left for it, -1: nothing it can start yet @param {typeof agents[number]} ag */
  const choose = (ag) => {
    const head = nth(queues, ag.a)[0];
    /** @type {number[]} */
    const cands = [];
    for (const i of pool) {
      if (ready(i)) cands.push(i);
      if (cands.length >= K) break;
    }
    if (head != null) {
      const first = cands.filter((i) => before(i, head) < 0);
      if (first.length) return nearest(ag, first);
      if (ready(head)) return head;
      return cands.length ? nearest(ag, cands) : -1;
    }
    if (cands.length) return nearest(ag, cands);
    return pool.length ? -1 : -2;
  };
  /** @param {typeof agents[number]} ag @param {number} i */
  const place = (ag, i) => {
    const it = nth(res, i);
    if (it.group != null && it.kind === "text") {
      // a repeated label is copied from the nearest place it has already landed
      let src = -1, best = Infinity;
      slots.forEach((sl, j) => {
        const other = nth(res, j);
        if (!sl || other.group !== it.group || sl.end > ag.free) return;
        const c = centre(other.rect);
        const d = Math.hypot(c[0] - ag.pos[0], c[1] - ag.pos[1]);
        if (d < best) { best = d; src = j; }
      });
      if (src >= 0) Object.assign(it, { kind: "copy", copyOf: src, src: nth(res, src).rect, group: undefined });
    }
    const hs = nth(holdsOf, ag.a);
    const to = workPoint(it, 0);
    const dur = travelOf(Math.hypot(to[0] - ag.pos[0], to[1] - ag.pos[1])) / speed;
    const t1 = advance(hs, ag.free, dur);
    const bow = (r() < 0.5 ? -1 : 1) * (0.05 + 0.1 * r());
    ag.segs.push({ kind: "travel", t0: ag.free, t1, dur, from: ag.pos, to, item: i, bow });
    const s0 = advance(hs, Math.max(t1, depEnd(i)), 0);
    if (s0 > t1) ag.segs.push({ kind: "wait", t0: t1, t1: s0, dur: s0 - t1, from: to, to, item: i, bow: 0 });
    const work = workOf(it) / speed;
    const s1 = advance(hs, s0, work);
    const end = workPoint(it, 1);
    ag.segs.push({ kind: "work", t0: s0, t1: s1, dur: work, from: to, to: end, item: i, bow: 0 });
    slots[i] = { agent: ag.a, arrive: t1, start: s0, end: s1, work, set: ag.k++ % 2 };
    ag.free = s1;
    ag.pos = end;
    const q = nth(queues, ag.a);
    if (q[0] === i) q.shift();
    else pool = pool.filter((j) => j !== i);
  };
  let left = items.length;
  while (left > 0) {
    const order = agents.filter((ag) => !ag.done).sort((x, y) => x.free - y.free || x.a - y.a);
    let took = false;
    for (const ag of order) {
      const pick = choose(ag);
      if (pick === -2) { ag.done = true; continue; }
      if (pick < 0) continue;
      place(ag, pick);
      left--;
      took = true;
      break;
    }
    if (took) continue;
    // every agent is waiting on something no one has taken: let the first such item go without it
    const stuck = items.findIndex((_, i) => !slots[i] && !ready(i));
    if (stuck < 0) break;
    broken.add(stuck);
  }
  let end = start;
  for (const sl of slots) if (sl) end = Math.max(end, sl.end);
  let gone = start;
  for (const ag of agents) {
    if (!ag.segs.length) continue;
    const hs = nth(holdsOf, ag.a);
    if (o.exit === "park") {
      ag.segs.push({ kind: "park", t0: ag.free, t1: o.out ?? Infinity, dur: 0, from: ag.pos, to: ag.pos, item: -1, bow: 0 });
      gone = Math.max(gone, o.out ?? Infinity);
      continue;
    }
    const linger = advance(hs, ag.free, 0.12 / speed);
    ag.segs.push({ kind: "wait", t0: ag.free, t1: linger, dur: linger - ag.free, from: ag.pos, to: ag.pos, item: -1, bow: 0 });
    const to = outside(bounds, ag.pos, 90, (r() - 0.5) * 120);
    const dur = travelOf(Math.hypot(to[0] - ag.pos[0], to[1] - ag.pos[1])) / speed;
    const t1 = advance(hs, linger, dur);
    ag.segs.push({ kind: "leave", t0: linger, t1, dur, from: ag.pos, to, item: -1, bow: (r() < 0.5 ? -1 : 1) * 0.08 });
    gone = Math.max(gone, t1);
  }
  return { slots: slots.map((sl) => /** @type {Slot} */ (sl)), segs: agents.map((ag) => ag.segs), end, gone, bounds, items: res };
}

// --- on a page -------------------------------------------------------------------

const MEDIA = new Set(["IMG", "SVG", "CANVAS", "VIDEO", "PICTURE", "IFRAME", "INPUT", "TEXTAREA", "SELECT", "OBJECT", "EMBED"]);
const SKIP = new Set(["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT", "HEAD", "META", "LINK", "BR", "WBR"]);

/** the colours, when none are given: hues spread round the wheel, light enough for a dark surface @param {number} n */
const hues = (n) => Array.from({ length: n }, (_, i) => `hsl(${Math.round((210 + (i * 360) / n) % 360)} 85% 70%)`);

/** dark ink on a light colour, white on a dark one @param {string} c */
export function inkOn(c) {
  const s = c.trim().toLowerCase();
  let l = 0.7;
  const hex = s.match(/^#([0-9a-f]{3,8})$/);
  const rgb = s.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/);
  const hsl = s.match(/^hsla?\(\s*[\d.]+(?:deg)?[,\s]+[\d.]+%[,\s]+([\d.]+)%/);
  /** @type {number[] | null} */
  let v = null;
  if (hex) {
    const h = nth(hex, 1);
    const full = h.length < 6 ? h.slice(0, 3).split("").map((x) => x + x).join("") : h.slice(0, 6);
    v = [0, 2, 4].map((k) => Number.parseInt(full.slice(k, k + 2), 16));
  } else if (rgb) v = [1, 2, 3].map((k) => Number(rgb[k]));
  if (v) l = (0.2126 * nth(v, 0) + 0.7152 * nth(v, 1) + 0.0722 * nth(v, 2)) / 255;
  else if (hsl) l = Number(hsl[1]) / 100;
  return l > 0.55 ? "#111318" : "#ffffff";
}

let styled = false;
function styles() {
  if (styled || typeof document === "undefined") return;
  styled = true;
  const k = "var(--swarm-k, 1)";
  const css = document.createElement("style");
  css.id = "swarm-css";
  css.textContent = `
.swarm-nopaint { background: transparent !important; background-image: none !important; border-color: transparent !important; box-shadow: none !important; outline-color: transparent !important; }
.swarm-hide { opacity: 0 !important; }
.swarm-still, .swarm-still * { transition: none !important; }
swarm-ghost { opacity: 0; }
swarm-ghost, swarm-wrap { display: inline; }
.swarm-layer { position: absolute; width: 0; height: 0; overflow: visible; pointer-events: none; z-index: 2147483000; }
.swarm-layer * { box-sizing: border-box; }
.swarm-abs { position: absolute; left: 0; top: 0; transform-origin: 0 0; }
.swarm-sel { border: calc(1.5px * ${k}) solid var(--c); }
.swarm-hd { position: absolute; width: calc(7px * ${k}); height: calc(7px * ${k}); background: #fff; border: calc(1.5px * ${k}) solid var(--c); border-radius: 1px; }
.swarm-hd0 { left: calc(-4px * ${k}); top: calc(-4px * ${k}); } .swarm-hd1 { right: calc(-4px * ${k}); top: calc(-4px * ${k}); }
.swarm-hd2 { left: calc(-4px * ${k}); bottom: calc(-4px * ${k}); } .swarm-hd3 { right: calc(-4px * ${k}); bottom: calc(-4px * ${k}); }
.swarm-badge { position: absolute; left: 50%; top: calc(100% + 5px * ${k}); transform: translateX(-50%); padding: calc(3px * ${k}) calc(5px * ${k}); border-radius: calc(2px * ${k}); background: var(--c); color: var(--ink); font: 500 calc(10px * ${k})/1 ui-monospace, Menlo, Consolas, monospace; white-space: nowrap; }
.swarm-fill { background: color-mix(in srgb, var(--c) 24%, transparent); }
.swarm-line { height: calc(2px * ${k}); margin-top: calc(-1px * ${k}); background: var(--c); box-shadow: 0 0 calc(6px * ${k}) var(--c); }
.swarm-guide { width: calc(1px * ${k}); background: var(--c); }
.swarm-clone { white-space: pre; }
.swarm-agent { position: absolute; left: 0; top: 0; width: 0; height: 0; transform-origin: 0 0; will-change: transform; filter: drop-shadow(0 1px 2px rgba(0, 0, 0, .5)); }
.swarm-agent svg { position: absolute; display: none; overflow: visible; }
.swarm-agent[data-mode=arrow] .swarm-i-arrow, .swarm-agent[data-mode=text] .swarm-i-text, .swarm-agent[data-mode=cross] .swarm-i-cross, .swarm-agent[data-mode=pen] .swarm-i-pen { display: block; }
.swarm-tag { position: absolute; left: 13px; top: 19px; padding: 3px 7px 4px; border-radius: 6px; background: var(--c); color: var(--ink); white-space: nowrap; }
.swarm-ring { position: absolute; left: -14px; top: -14px; width: 28px; height: 28px; border-radius: 50%; border: 2px solid var(--c); display: none; }
`;
  document.head.append(css);
}

const SVG = (/** @type {string} */ cls, /** @type {string} */ body) =>
  `<svg class="${cls}" width="1" height="1" viewBox="0 0 1 1">${body}</svg>`;
const ICONS =
  SVG("swarm-i-arrow", `<path d="M0 0 L0 17 L4.6 12.8 L7.6 19.4 L10.4 18.2 L7.5 11.7 L13.4 11.7 Z" fill="var(--c)" stroke="rgba(0,0,0,.6)" stroke-width="1.1" stroke-linejoin="round"/>`) +
  SVG("swarm-i-text", `<path d="M-3.5 -9 H3.5 M0 -9 V9 M-3.5 9 H3.5" style="transform: scale(var(--ib, 1))" fill="none" stroke="var(--c)" stroke-width="1.8" stroke-linecap="round"/>`) +
  SVG("swarm-i-cross", `<path d="M-9 0 H-3 M3 0 H9 M0 -9 V-3 M0 3 V9" fill="none" stroke="var(--c)" stroke-width="1.8" stroke-linecap="round"/>`) +
  SVG("swarm-i-pen", `<path d="M0 0 L2.6 -8.4 L12.6 -18.4 L16.4 -14.6 L6.4 -4.6 Z" fill="var(--c)" stroke="rgba(0,0,0,.6)" stroke-width="1" stroke-linejoin="round"/>`);

/**
 * The page's layout read with the transforms of `root` and everything above it
 * set aside, so a root under a camera or a tilt is read in its own px.
 * @template T @param {Element} root @param {() => T} fn @returns {T}
 */
function flat(root, fn) {
  /** @type {[HTMLElement, string, string, string][]} */
  const saved = [];
  for (let e = /** @type {Element | null} */ (root); e; e = e.parentElement) {
    if (!(e instanceof HTMLElement)) continue;
    const cs = getComputedStyle(e);
    for (const p of ["transform", "translate", "scale", "rotate"]) {
      if (cs.getPropertyValue(p) === "none" || cs.getPropertyValue(p) === "") continue;
      saved.push([e, p, e.style.getPropertyValue(p), e.style.getPropertyPriority(p)]);
      e.style.setProperty(p, "none", "important");
    }
  }
  try {
    return fn();
  } finally {
    for (const [e, p, v, pr] of saved.reverse()) {
      if (v) e.style.setProperty(p, v, pr);
      else e.style.removeProperty(p);
    }
  }
}

/** a colour that paints something @param {string} c */
const shows = (c) => !!c && c !== "transparent" && !/(?:,|\/)\s*0(?:\.0*)?\s*\)$/.test(c) && !/^rgba\(.*,\s*0\)$/.test(c);

/** the element's own paint: none, a box, or a rule along one edge @param {CSSStyleDeclaration} cs @param {DOMRect} r */
function paintOf(cs, r) {
  const bg = shows(cs.backgroundColor) || cs.backgroundImage !== "none";
  const sides = ["Top", "Right", "Bottom", "Left"].filter(
    (s) => Number.parseFloat(cs.getPropertyValue(`border-${s.toLowerCase()}-width`)) > 0 &&
      cs.getPropertyValue(`border-${s.toLowerCase()}-style`) !== "none" &&
      shows(cs.getPropertyValue(`border-${s.toLowerCase()}-color`)),
  );
  const shadow = cs.boxShadow !== "none";
  if (!bg && !sides.length && !shadow) return null;
  if (r.height <= 4 || r.width <= 4) return { kind: /** @type {const} */ ("rule"), edge: r.height <= 4 ? "h" : "v" };
  if (!bg && !shadow && sides.length === 1) return { kind: /** @type {const} */ ("rule"), edge: nth(sides, 0) };
  return { kind: /** @type {const} */ ("box"), edge: "" };
}

/** @param {Element} el */
const isMedia = (el) => MEDIA.has(el.tagName.toUpperCase()) || el.getAttribute("data-swarm") === "media";

/** all of its content is inline text (no picture, no block) @param {Element} el @returns {boolean} */
function inlineOnly(el) {
  for (const c of Array.from(el.children)) {
    if (isMedia(c)) return false;
    if (SKIP.has(c.tagName.toUpperCase())) continue;
    const d = getComputedStyle(c).display;
    if (d !== "inline" && d !== "contents") return false;
    if (!inlineOnly(c)) return false;
  }
  return true;
}

/** @param {Node} el @param {boolean} deep @returns {Text[]} */
function textNodes(el, deep) {
  /** @type {Text[]} */
  const out = [];
  for (const c of Array.from(el.childNodes)) {
    if (c.nodeType === 3 && /** @type {Text} */ (c).data.trim()) out.push(/** @type {Text} */ (c));
    else if (deep && c.nodeType === 1 && !SKIP.has(/** @type {Element} */ (c).tagName.toUpperCase())) out.push(...textNodes(c, true));
  }
  return out;
}

/**
 * @typedef {object} Part  one text node of a text item, split while it is typed
 * @property {Text} node
 * @property {string} text   its data as the page had it
 * @property {number[]} cuts cuts[m]: the length of text showing m characters
 * @property {HTMLElement | null} ghost
 * @property {HTMLElement | null} wrap
 * @property {boolean} wraps   its parent lays out flex or grid items
 */
/**
 * @typedef {object} DomItem
 * @property {Element} el
 * @property {Kind} kind
 * @property {Part[]} parts
 * @property {number} chars
 * @property {string} clip     media: its own inline clip-path
 * @property {string} key      what was last written
 * @property {string} text
 * @property {Record<string, string>} font  copy: the original's type, for the copy in flight
 */

/** the characters a reader sees in s, as cut points (a run of spaces is one) @param {string} s @param {boolean} pre */
function cutsOf(s, pre) {
  const cuts = [0];
  /** @type {number[]} */
  const at = [];
  for (let i = 0; i < s.length; i++) {
    const ws = /\s/.test(s.charAt(i));
    if (!pre && ws && i > 0 && /\s/.test(s.charAt(i - 1))) continue;
    at.push(i);
    cuts.push(i + 1);
  }
  cuts[cuts.length - 1] = s.length;
  return { cuts, at };
}

/** the client rect of a range, or null @param {Range} rg */
const lastRect = (rg) => {
  const rs = rg.getClientRects();
  const r = rs[rs.length - 1];
  return r && (r.width > 0 || r.height > 0) ? r : null;
};

/**
 * Builds the overlay and the plan for a set of items on a page; `write(t)`
 * puts the page's own side (what is hidden or shown) for each draw.
 * @param {HTMLElement} root @param {object} o
 * @param {(layer: HTMLElement, origin: Pt) => { items: PlanItem[], els: (Element | null)[], fonts: (Record<string, string> | null)[], write: (P: ReturnType<typeof plan>, t: number) => void }} scan
 */
function mount(root, o, scan) {
  const opt = /** @type {any} */ (o);
  styles();
  const layer = document.createElement("div");
  layer.className = "swarm-layer";
  layer.setAttribute("aria-hidden", "true");
  root.append(layer);
  const rcs = getComputedStyle(root);
  if (rcs.position !== "static" || rcs.transform !== "none") { layer.style.left = "0"; layer.style.top = "0"; }
  if (opt.lift) {
    layer.style.transform = `translateZ(${opt.lift}px)`;
    root.style.transformStyle = "preserve-3d";
  }
  const read = flat(root, () => {
    const lr = layer.getBoundingClientRect();
    const rr = root.getBoundingClientRect();
    /** @type {Pt} */
    const origin = [lr.left, lr.top];
    const found = scan(layer, origin);
    /** @type {Pt} */
    const offset = [lr.left - rr.left, lr.top - rr.top];
    return { ...found, offset, rootRect: { x: rr.left - lr.left, y: rr.top - lr.top, w: rr.width, h: rr.height } };
  });
  const { items, els, fonts, write, offset, rootRect } = read;
  const n = Math.max(1, Math.round(opt.agents ?? 8));
  const P = plan(items, {
    agents: n, seed: opt.seed, start: opt.start, duration: opt.duration, speed: opt.speed, holds: opt.holds,
    exit: opt.exit, out: opt.out, stagger: opt.stagger, bounds: rootRect,
    from: opt.from?.map((/** @type {{ x: number, y: number }} */ p) => ({ x: p.x - offset[0], y: p.y - offset[1] })),
  });
  /** @type {string[]} */
  const colors = opt.colors?.length ? opt.colors : hues(n);
  const colorOf = (/** @type {number} */ a) => nth(colors, a % colors.length);
  /** @type {(string | undefined)[]} */
  const labels = opt.labels ?? [];
  const font = opt.font ?? `600 12px/1.2 ui-sans-serif, system-ui, -apple-system, "PingFang TC", "Noto Sans TC", "Segoe UI", sans-serif`;
  const guides = opt.guides !== false;
  const constant = opt.constantSize !== false;
  const seed = opt.seed ?? 1;
  const guided = (/** @type {number} */ i) => {
    const s = Math.sin((i + 1) * 12.9898 + seed * 78.233) * 43758.5453;
    return s - Math.floor(s) < 0.3;
  };

  const mk = (/** @type {string} */ cls, /** @type {HTMLElement} */ parent, /** @type {string} */ tag = "div") => {
    const e = document.createElement(tag);
    e.className = cls;
    parent.append(e);
    return e;
  };
  const sets = Array.from({ length: n }, (_, a) =>
    [0, 1].map(() => {
      const guide = mk("swarm-abs swarm-guide", layer);
      const fill = mk("swarm-abs swarm-fill", layer);
      const line = mk("swarm-abs swarm-line", layer);
      const clone = mk("swarm-abs swarm-clone", layer);
      const sel = mk("swarm-abs swarm-sel", layer);
      for (let h = 0; h < 4; h++) mk(`swarm-hd swarm-hd${h}`, sel);
      const badge = mk("swarm-badge", sel);
      for (const e of [guide, fill, line, clone, sel]) e.style.display = "none";
      return { guide, fill, line, clone, sel, badge, a, cloneOf: -1 };
    }),
  );
  const cursors = Array.from({ length: n }, (_, a) => {
    const el = mk("swarm-agent", layer);
    el.innerHTML = ICONS;
    const ring = mk("swarm-ring", el);
    const tag = mk("swarm-tag", el, "span");
    tag.style.font = font;
    el.style.display = "none";
    el.dataset.mode = "arrow";
    return { el, ring, tag, a };
  });
  layer.style.display = "none";

  /** @param {HTMLElement} e @param {boolean} on */
  const show = (e, on) => { const v = on ? "" : "none"; if (e.style.display !== v) e.style.display = v; };
  /** @param {HTMLElement} e @param {string} c */
  const paint = (e, c) => { if (e.style.getPropertyValue("--c") !== c) { e.style.setProperty("--c", c); e.style.setProperty("--ink", inkOn(c)); } };
  /** @param {HTMLElement} e @param {Rect} r */
  const place = (e, r) => {
    e.style.transform = `translate(${r.x.toFixed(2)}px, ${r.y.toFixed(2)}px)`;
    e.style.width = `${Math.max(0, r.w).toFixed(2)}px`;
    e.style.height = `${Math.max(0, r.h).toFixed(2)}px`;
  };

  /** one agent's selection, fill, line, guide and copy for item i at progress p @param {typeof sets[number][number]} s @param {number} i @param {number} p @param {number} since @param {number} alpha @param {string} c @param {number} k */
  const chrome = (s, i, p, since, alpha, c, k) => {
    const it = nth(P.items, i);
    const r = it.rect;
    for (const e of [s.sel, s.fill, s.line, s.guide, s.clone]) paint(e, c);
    let sel = /** @type {Rect | null} */ (null), fill = /** @type {Rect | null} */ (null), fillAlpha = 1, wipe = 0;
    if (it.kind === "box" || it.kind === "media") {
      const q = ease.out3(clamp(p / (it.kind === "media" ? 0.33 : 0.55)));
      sel = fill = { x: r.x, y: r.y, w: r.w * q, h: r.h * q };
      if (it.kind === "box") fillAlpha = p < 0.55 ? 1 : 1 - (p - 0.55) / 0.45;
      else wipe = p > 0.33 ? ease.inOut3((p - 0.33) / 0.67) : 0;
    } else if (it.kind === "text") {
      sel = { x: r.x - 2, y: r.y - 2, w: r.w + 4, h: r.h + 4 };
    } else if (it.kind === "copy") {
      const src = it.src ?? r;
      const q = ease.inOut3(clamp(p / 0.5));
      const x = lerp(src.x, r.x, q), y = lerp(src.y, r.y, q);
      sel = { x: x - 2, y: y - 2, w: lerp(src.w, r.w, q) + 4, h: lerp(src.h, r.h, q) + 4 };
      const flying = p < 0.5;
      show(s.clone, flying && alpha > 0);
      if (flying) {
        if (s.cloneOf !== i) {
          s.cloneOf = i;
          const el = els[it.copyOf ?? -1] ?? els[i];
          s.clone.textContent = el?.textContent?.trim() ?? "";
          Object.assign(s.clone.style, fonts[i] ?? {});
        }
        s.clone.style.transform = `translate(${x.toFixed(2)}px, ${y.toFixed(2)}px)`;
        s.clone.style.opacity = String(alpha);
      }
    }
    if (it.kind !== "copy") show(s.clone, false);
    show(s.sel, !!sel && alpha > 0);
    if (sel) {
      place(s.sel, sel);
      s.sel.style.opacity = String(alpha);
      const sized = it.kind === "box" || it.kind === "media";
      show(s.badge, sized);
      const txt = sized ? `${Math.round(sel.w)} × ${Math.round(sel.h)}` : "";
      if (s.badge.textContent !== txt) s.badge.textContent = txt;
    }
    show(s.fill, !!fill && alpha * fillAlpha > 0);
    if (fill) {
      place(s.fill, fill);
      s.fill.style.opacity = String(alpha * clamp(fillAlpha));
      s.fill.style.clipPath = wipe > 0 ? `inset(${(wipe * 100).toFixed(2)}% 0 0 0)` : "";
    }
    const isRule = it.kind === "rule";
    show(s.line, isRule && alpha > 0);
    if (isRule) {
      const a = nth(/** @type {Pt[]} */ (it.path ?? [[r.x, r.y]]), 0);
      const tip = workPoint(it, p);
      const len = Math.hypot(tip[0] - a[0], tip[1] - a[1]);
      s.line.style.transform = `translate(${a[0].toFixed(2)}px, ${a[1].toFixed(2)}px) rotate(${Math.atan2(tip[1] - a[1], tip[0] - a[0])}rad)`;
      s.line.style.width = `${len.toFixed(2)}px`;
      s.line.style.opacity = String(alpha);
    }
    const g = guides && (it.kind === "box" || it.kind === "media") && guided(i) && since < 0.45;
    show(s.guide, g && alpha > 0);
    if (g) {
      const b = P.bounds;
      s.guide.style.transform = `translate(${(r.x - 0.5 * k).toFixed(2)}px, ${b.y.toFixed(2)}px)`;
      s.guide.style.height = `${b.h.toFixed(2)}px`;
      s.guide.style.opacity = String(0.55 * alpha * (1 - since / 0.45));
    }
  };

  /** the root's scale on screen, read from its box @returns {number} */
  const screenScale = () => {
    const w = root.offsetWidth;
    if (!w) return 1;
    const s = root.getBoundingClientRect().width / w;
    return s > 0.01 ? s : 1;
  };

  /** @param {number} t */
  const draw = (t) => {
    const live = t >= P.start && t < P.gone;
    const k = live && constant ? 1 / screenScale() : 1;
    write(P, t);
    show(layer, live);
    if (!live) return;
    layer.style.setProperty("--swarm-k", k.toFixed(4));
    for (let a = 0; a < n; a++) {
      const cur = nth(cursors, a);
      const at = P.agentAt(a, t);
      show(cur.el, !!at);
      const segs = nth(P.segs, a);
      /** @type {Seg[]} */
      const shown = [];
      for (const sg of segs) {
        if (sg.kind !== "work") continue;
        if (t >= sg.t0 && t < sg.t1) shown.push(sg);
        else if (t >= sg.t1 && t < sg.t1 + FADE) shown.push(sg);
      }
      const used = new Set();
      const held = at?.held ?? null;
      const c = held ? (held.color ?? "#fbbf24") : colorOf(a);
      for (const sg of shown) {
        const sl = nth(P.slots, sg.item);
        const s = nth(nth(sets, a), sl.set);
        used.add(s);
        const st = P.itemAt(sg.item, t);
        const alpha = st.phase === 2 ? clamp(1 - (t - sl.end) / FADE) : 1;
        chrome(s, sg.item, st.p, t - sl.start, alpha, c, k);
      }
      for (const s of nth(sets, a)) if (!used.has(s)) for (const e of [s.sel, s.fill, s.line, s.guide, s.clone]) show(e, false);
      if (!at) continue;
      cur.el.style.transform = `translate(${at.x.toFixed(2)}px, ${at.y.toFixed(2)}px) scale(${k.toFixed(4)})`;
      cur.el.style.opacity = String(at.alpha);
      const kind = at.seg === "work" && at.item >= 0 ? nth(P.items, at.item).kind : null;
      const mode = kind === "text" ? "text" : kind === "rule" ? "pen" : kind === "box" || kind === "media" ? "cross" : "arrow";
      if (cur.el.dataset.mode !== mode) cur.el.dataset.mode = mode;
      if (mode === "text") cur.el.style.setProperty("--ib", clamp(lineH(nth(P.items, at.item)) / 18, 0.6, 3).toFixed(3));
      paint(cur.el, c);
      const label = held ? (held.label ?? labels[a]) : labels[a];
      show(cur.tag, !!label);
      if (label && cur.tag.textContent !== label) cur.tag.textContent = label;
      show(cur.ring, !!held);
      if (held) {
        const ph = (((t - held.from) % 1.1) + 1.1) % 1.1 / 1.1;
        cur.ring.style.transform = `scale(${(0.5 + 1.1 * ph).toFixed(3)})`;
        cur.ring.style.opacity = String((1 - ph).toFixed(3));
      }
    }
  };

  /** in root px @param {number} t */
  const agentsAt = (t) =>
    Array.from({ length: n }, (_, a) => {
      const at = P.agentAt(a, t);
      const held = at?.held ?? null;
      return {
        x: (at?.x ?? 0) + offset[0], y: (at?.y ?? 0) + offset[1], visible: !!at,
        label: held ? (held.label ?? labels[a] ?? "") : (labels[a] ?? ""),
        color: held ? (held.color ?? "#fbbf24") : colorOf(a),
        state: at ? at.state : t < P.start ? "waiting" : "gone",
      };
    });

  return {
    el: layer,
    draw,
    agentsAt,
    end: P.end,
    events: P.events.map((e) => ({ ...e, el: e.item >= 0 ? (els[e.item] ?? null) : null })),
    items: P.slots.map((sl, i) => {
      const r = nth(P.items, i).rect;
      return { el: els[i] ?? null, kind: nth(P.items, i).kind, agent: sl.agent, arrive: sl.arrive, start: sl.start, end: sl.end, rect: { x: r.x + offset[0], y: r.y + offset[1], w: r.w, h: r.h } };
    }),
    plan: P,
  };
}

/** a text item's line height, from its caret path's first character @param {PlanItem} it */
function lineH(it) {
  return /** @type {any} */ (it).lineH ?? 18;
}

/**
 * @typedef {object} SwarmOptions
 * @property {number} [agents]
 * @property {number} [seed]
 * @property {number} [start]
 * @property {number} [duration]
 * @property {number} [speed]
 * @property {string[]} [labels]
 * @property {string[]} [colors]
 * @property {"nearest" | ((item: { el: Element | null, kind: Kind, rect: Rect, text: string }, i: number) => number | null | undefined)} [assign]
 * @property {Hold[]} [holds]
 * @property {{ x: number, y: number }[]} [from]
 * @property {"leave" | "park"} [exit]
 * @property {number} [out]
 * @property {number} [lift]
 * @property {boolean} [constantSize]
 * @property {boolean} [copies]
 * @property {boolean} [guides]
 * @property {string} [font]
 * @property {number} [stagger]
 */
/**
 * @typedef {object} Swarm
 * @property {HTMLElement | null} el
 * @property {(t: number) => void} draw
 * @property {number} end
 * @property {{ t: number, agent: number, kind: string, item: number, el: Element | null }[]} events
 * @property {{ el: Element | null, kind: Kind, agent: number, arrive: number, start: number, end: number, rect: Rect }[]} items
 * @property {(t: number) => { x: number, y: number, visible: boolean, label: string, color: string, state: string }[]} agentsAt
 */

/** built on first use: `end`, `events` and the rest read the page's layout @param {() => any} make @returns {Swarm} */
function lazy(make) {
  /** @type {any} */
  let b = null;
  const get = () => (b ??= make());
  return {
    get el() { return get().el; },
    draw: (t) => get().draw(t),
    get end() { return get().end; },
    get events() { return get().events; },
    get items() { return get().items; },
    agentsAt: (t) => get().agentsAt(t),
  };
}

/**
 * A team of agent cursors builds what is inside `root`. Built on first use
 * (draw, end, events): read them after `await document.fonts.ready`.
 * @param {HTMLElement} root @param {SwarmOptions} [o] @returns {Swarm}
 */
export function swarm(root, o = {}) {
  return lazy(() =>
    mount(root, o, (layer, origin) => {
      const rel = (/** @type {DOMRect} */ r) => ({ x: r.left - origin[0], y: r.top - origin[1], w: r.width, h: r.height });
      /** @type {PlanItem[]} */
      const items = [];
      /** @type {DomItem[]} */
      const dom = [];
      /** @type {Map<Element, number>} */
      const boxOf = new Map();
      /** @param {Element} el */
      const fixedAgent = (el) => {
        const host = el.closest("[data-swarm-agent]");
        return host && root.contains(host) ? Number(host.getAttribute("data-swarm-agent")) : undefined;
      };
      /** @param {Element} el */
      const orderOf = (el) => {
        const host = el.closest("[data-swarm-order]");
        return host && root.contains(host) ? Number(host.getAttribute("data-swarm-order")) : undefined;
      };
      /** @param {DomItem} d @param {PlanItem} p */
      const add = (d, p) => {
        const a = fixedAgent(d.el);
        if (a != null && Number.isFinite(a)) p.agent = a;
        const ord = orderOf(d.el);
        if (ord != null && Number.isFinite(ord)) p.order = ord;
        items.push(p);
        dom.push(d);
        return items.length - 1;
      };
      /** @param {Element} el */
      const visit = (el) => {
        if (el === layer || el.hasAttribute("data-swarm-skip") || SKIP.has(el.tagName.toUpperCase())) return;
        const cs = getComputedStyle(el);
        if (cs.display === "none" || cs.visibility === "hidden" || cs.visibility === "collapse") return;
        if (el !== root && Number.parseFloat(cs.opacity) === 0) return;
        const br = el.getBoundingClientRect();
        const base = { el, parts: [], chars: 0, clip: "", key: "", text: "", font: {} };
        if (el !== root && isMedia(el)) {
          if (br.width > 1 && br.height > 1) {
            const clip = el instanceof HTMLElement || el instanceof SVGElement ? el.style.clipPath : "";
            add({ ...base, kind: "media", clip }, { kind: "media", rect: rel(br) });
          }
          return;
        }
        if (el !== root) {
          const forced = el.getAttribute("data-swarm") === "box";
          const pt = forced ? { kind: /** @type {const} */ ("box"), edge: "" } : paintOf(cs, br);
          if (pt && br.width > 0 && br.height > 0) {
            const r = rel(br);
            /** @type {Pt[] | undefined} */
            let path;
            if (pt.kind === "rule") {
              const e = pt.edge;
              if (e === "Top" || e === "h") path = [[r.x, e === "h" ? r.y + r.h / 2 : r.y + 0.5], [r.x + r.w, e === "h" ? r.y + r.h / 2 : r.y + 0.5]];
              else if (e === "Bottom") path = [[r.x, r.y + r.h - 0.5], [r.x + r.w, r.y + r.h - 0.5]];
              else if (e === "Left" || e === "v") path = [[e === "v" ? r.x + r.w / 2 : r.x + 0.5, r.y], [e === "v" ? r.x + r.w / 2 : r.x + 0.5, r.y + r.h]];
              else path = [[r.x + r.w - 0.5, r.y], [r.x + r.w - 0.5, r.y + r.h]];
            }
            boxOf.set(el, add({ ...base, kind: pt.kind }, { kind: pt.kind, rect: r, path }));
          }
        }
        const leaf = inlineOnly(el);
        const nodes = textNodes(el, leaf);
        if (nodes.length) {
          const pre = cs.whiteSpace.startsWith("pre") || cs.whiteSpace === "break-spaces";
          /** @type {Part[]} */
          const parts = [];
          /** @type {Pt[]} */
          const path = [];
          /** @type {Rect[]} */
          const rects = [];
          /** @type {number[]} */
          const heights = [];
          const rg = document.createRange();
          for (const node of nodes) {
            const { cuts, at } = cutsOf(node.data, pre);
            const parent = node.parentElement;
            const wraps = !!parent && /flex|grid/.test(getComputedStyle(parent).display);
            parts.push({ node, text: node.data, cuts, ghost: null, wrap: null, wraps });
            rg.selectNodeContents(node);
            for (const r of Array.from(rg.getClientRects())) if (r.width > 0 && r.height > 0) rects.push(rel(r));
            for (const i of at) {
              rg.setStart(node, i);
              rg.setEnd(node, i + 1);
              const r = lastRect(rg);
              if (!r) {
                if (path.length) path.push(/** @type {Pt} */ (path[path.length - 1]));
                continue;
              }
              const q = rel(r);
              if (!path.length) path.push([q.x, q.y + q.h / 2]);
              path.push([q.x + q.w, q.y + q.h / 2]);
              heights.push(q.h);
            }
          }
          rg.detach();
          if (rects.length && path.length > 1) {
            const text = nodes.map((x) => x.data).join("").replace(/\s+/g, " ").trim();
            const chars = parts.reduce((s, p) => s + p.cuts.length - 1, 0);
            while (path.length < chars + 1) path.push(/** @type {Pt} */ (path[path.length - 1]));
            const pi = /** @type {PlanItem & { lineH?: number }} */ ({ kind: "text", rect: union(rects), path: path.slice(0, chars + 1), lineH: heights.sort((a, b) => a - b)[heights.length >> 1] ?? 18 });
            const box = boxOf.get(el);
            if (box != null) pi.after = box;
            const fcs = cs;
            add({ ...base, kind: "text", parts, chars, text, font: { font: fcs.font, letterSpacing: fcs.letterSpacing, color: fcs.color, textTransform: fcs.textTransform } }, pi);
          }
        }
        if (!leaf) for (const c of Array.from(el.children)) visit(c);
      };
      visit(root);

      // a short label repeated three times or more is copied from its first place
      if (o.copies !== false) {
        /** @type {Map<string, number[]>} */
        const groups = new Map();
        dom.forEach((d, i) => {
          if (d.kind !== "text" || d.text.length > 28 || d.el.children.length) return;
          const key = `${d.el.tagName}|${d.el.getAttribute("class") ?? ""}|${d.text}`;
          groups.set(key, [...(groups.get(key) ?? []), i]);
        });
        let id = 0;
        for (const g of groups.values()) {
          if (g.length < 3) continue;
          for (const i of g) nth(items, i).group = id;
          id++;
        }
      }
      if (typeof o.assign === "function") {
        const fn = o.assign;
        items.forEach((it, i) => {
          if (it.agent != null) return;
          const d = nth(dom, i);
          const a = fn({ el: d.el, kind: it.kind, rect: it.rect, text: d.text }, i);
          if (a != null && Number.isFinite(a) && a >= 0) it.agent = a;
        });
      }

      /** the page's side at t @param {ReturnType<typeof plan>} P @param {number} t */
      const write = (P, t) => {
        const before = t < P.start;
        dom.forEach((d, i) => {
          const sl = P.slots[i];
          const st = before ? { phase: 0, p: 0 } : P.itemAt(i, t);
          const still = !sl || t < sl.end + 0.5;
          const copy = P.items[i]?.kind === "copy";
          let key = "";
          if (d.kind === "text") {
            const k = st.phase === 2 ? -1 : copy ? (st.p >= 0.5 ? d.chars : 0) : Math.floor(st.p * d.chars + 1e-9);
            key = `t${k}`;
            if (key !== d.key) typeText(d, k);
          } else if (d.kind === "box" || d.kind === "rule") {
            const on = st.phase === 2 || (d.kind === "box" && st.phase === 1 && st.p >= 0.55);
            key = on ? "on" : "off";
            if (key !== d.key) d.el.classList.toggle("swarm-nopaint", !on);
          } else {
            const q = st.phase === 2 ? 1 : st.phase === 1 && st.p >= 0.33 ? ease.inOut3((st.p - 0.33) / 0.67) : 0;
            key = st.phase === 2 ? "done" : `m${q.toFixed(4)}`;
            if (key !== d.key) {
              const e = /** @type {HTMLElement} */ (d.el);
              e.classList.toggle("swarm-hide", q === 0 && st.phase !== 2);
              e.style.clipPath = st.phase === 2 ? d.clip : q > 0 ? `inset(0 0 ${((1 - q) * 100).toFixed(3)}% 0)` : d.clip;
            }
          }
          key += still ? "s" : "";
          if (key !== d.key) {
            d.el.classList.toggle("swarm-still", still);
            d.key = key;
          }
        });
      };
      return { items, els: dom.map((d) => d.el), fonts: dom.map((d) => (d.kind === "text" ? d.font : null)), write };
    }),
  );
}

/** a text item showing k characters (-1: as the page had it, the split undone) @param {DomItem} d @param {number} k */
function typeText(d, k) {
  let left = k;
  for (const p of d.parts) {
    if (k < 0) {
      if (!p.ghost) continue;
      p.node.data = p.text;
      p.ghost.remove();
      p.ghost = null;
      if (p.wrap) {
        p.wrap.parentNode?.insertBefore(p.node, p.wrap);
        p.wrap.remove();
        p.wrap = null;
      }
      continue;
    }
    if (!p.ghost) {
      const parent = p.node.parentNode;
      if (!parent) continue;
      if (p.wraps) {
        p.wrap = document.createElement("swarm-wrap");
        parent.insertBefore(p.wrap, p.node);
        p.wrap.append(p.node);
      }
      p.ghost = document.createElement("swarm-ghost");
      p.ghost.append(document.createTextNode(""));
      p.node.parentNode?.insertBefore(p.ghost, p.node.nextSibling);
    }
    const m = Math.min(p.cuts.length - 1, Math.max(0, left));
    left -= m;
    const cut = nth(p.cuts, m);
    p.node.data = p.text.slice(0, cut);
    const g = /** @type {Text} */ (p.ghost.firstChild);
    g.data = p.text.slice(cut);
  }
}

/**
 * The colour round a rect of a picture (the median of a ring just outside
 * it), for the patch that hides what is printed there; `fallback` when the
 * picture cannot be read (another origin).
 * @param {HTMLElement} el @param {Rect} px  where the picture is laid out @param {string} fallback
 * @returns {(r: Rect) => string}  r in the picture's laid-out px
 */
function sampler(el, px, fallback) {
  const m = /** @type {any} */ (el);
  const w = Math.round(m.naturalWidth || m.videoWidth || m.width || px.w);
  const h = Math.round(m.naturalHeight || m.videoHeight || m.height || px.h);
  /** @type {Uint8ClampedArray | null} */
  let data = null;
  try {
    const cv = document.createElement("canvas");
    cv.width = w;
    cv.height = h;
    const g = cv.getContext("2d", { willReadFrequently: true });
    if (g) {
      g.drawImage(/** @type {CanvasImageSource} */ (m), 0, 0, w, h);
      data = g.getImageData(0, 0, w, h).data;
    }
  } catch {
    data = null;
  }
  const k = w / (px.w || 1);
  return (r) => {
    if (!data) return fallback;
    const d = 3;
    const x0 = r.x * k - d, y0 = r.y * k - d, x1 = (r.x + r.w) * k + d, y1 = (r.y + r.h) * k + d;
    /** @type {[number, number, number, number][]} */
    const px4 = [];
    for (let s = 0; s <= 24; s++) {
      const u = s / 24;
      for (const [x, y] of [[lerp(x0, x1, u), y0], [lerp(x0, x1, u), y1], [x0, lerp(y0, y1, u)], [x1, lerp(y0, y1, u)]]) {
        const xi = Math.round(clamp(/** @type {number} */ (x), 0, w - 1)), yi = Math.round(clamp(/** @type {number} */ (y), 0, h - 1));
        const j = 4 * (yi * w + xi);
        const c = /** @type {[number, number, number]} */ ([data[j] ?? 0, data[j + 1] ?? 0, data[j + 2] ?? 0]);
        px4.push([0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2], ...c]);
      }
    }
    px4.sort((a, b) => a[0] - b[0]);
    const mid = nth(px4, px4.length >> 1);
    return `rgb(${mid[1]}, ${mid[2]}, ${mid[3]})`;
  };
}

/**
 * The same cursors over a picture of a screen (an <img>, <video> or
 * <canvas> of a recorded or saved screen): each box is revealed through a
 * mask of its own as its agent builds it — dragged and shown ("box", the
 * default), typed left to right ("text"), drawn ("line") or wiped down
 * ("media") — and when the last has landed the rest of the picture comes in
 * over `settle` s (0.4). `under` (0) is how much of the picture shows where
 * nothing is built yet. Boxes in the picture's own px, or in `size` [w, h].
 * A box inside another is printed in the other's pixels: while the outer one
 * shows and the inner one is not built, the inner one is covered by a patch
 * in the colour round it (sampled from the picture; `patch` when it cannot be
 * read), so a card shows empty until its rows are typed in.
 * The overlay goes in `o.root` (default the picture's parent).
 * @param {HTMLElement} el
 * @param {({ x: number, y: number, w?: number, h?: number, width?: number, height?: number, kind?: "box" | "text" | "line" | "media", label?: string, agent?: number, order?: number } | [number, number, number, number])[]} boxes
 * @param {SwarmOptions & { root?: HTMLElement, size?: [number, number], under?: number, settle?: number, patch?: string }} [o]
 * @returns {Swarm}
 */
export function swarmBoxes(el, boxes, o = {}) {
  const root = o.root ?? /** @type {HTMLElement} */ (el.parentElement);
  return lazy(() =>
    mount(root, o, (_layer, origin) => {
      const pr = el.getBoundingClientRect();
      const px = { x: pr.left - origin[0], y: pr.top - origin[1], w: pr.width, h: pr.height };
      const media = /** @type {any} */ (el);
      const [sw, sh] = o.size ?? [media.naturalWidth || media.videoWidth || media.width || pr.width, media.naturalHeight || media.videoHeight || media.height || pr.height];
      const sx = px.w / (sw || 1), sy = px.h / (sh || 1);
      /** @type {PlanItem[]} */
      const items = [];
      /** @type {Rect[]} */
      const local = [];
      const kinds = /** @type {("box" | "text" | "line" | "media")[]} */ ([]);
      for (const b of boxes) {
        const [x, y, w, h] = Array.isArray(b) ? b : [b.x, b.y, b.w ?? b.width ?? 0, b.h ?? b.height ?? 0];
        const kind = Array.isArray(b) ? "box" : (b.kind ?? "box");
        const r = { x: px.x + x * sx, y: px.y + y * sy, w: w * sx, h: h * sy };
        local.push({ x: x * sx, y: y * sy, w: w * sx, h: h * sy });
        kinds.push(kind);
        /** @type {PlanItem} */
        const it = { kind: kind === "line" ? "rule" : kind, rect: r };
        if (kind === "text") {
          const chars = Math.max(4, Math.round(r.w / Math.max(4, r.h * 0.55)));
          it.path = Array.from({ length: chars + 1 }, (_, k) => /** @type {Pt} */ ([r.x + (r.w * k) / chars, r.y + r.h / 2]));
        } else if (kind === "line") it.path = [[r.x, r.y + r.h / 2], [r.x + r.w, r.y + r.h / 2]];
        if (!Array.isArray(b)) {
          if (b.agent != null) it.agent = b.agent;
          if (b.order != null) it.order = b.order;
        }
        items.push(it);
      }
      if (typeof o.assign === "function") {
        const fn = o.assign;
        items.forEach((it, i) => {
          if (it.agent != null) return;
          const a = fn({ el, kind: it.kind, rect: it.rect, text: "" }, i);
          if (a != null && Number.isFinite(a) && a >= 0) it.agent = a;
        });
      }
      const under = clamp(o.under ?? 0);
      const settle = o.settle ?? 0.4;
      const own = { mask: el.style.getPropertyValue("mask"), webkit: el.style.getPropertyValue("-webkit-mask") };

      // A box printed inside another (rows in a card) is part of the card's
      // pixels: while the card is shown and the row is not built yet, a patch
      // in the colour round the row covers it, so the card shows empty.
      const area = (/** @type {Rect} */ r) => r.w * r.h;
      const inside = (/** @type {Rect} */ a, /** @type {Rect} */ b) =>
        a.x >= b.x - 1 && a.y >= b.y - 1 && a.x + a.w <= b.x + b.w + 1 && a.y + a.h <= b.y + b.h + 1 && area(a) < area(b);
      const parent = local.map((r, i) => {
        let best = -1;
        local.forEach((q, j) => {
          const k = nth(kinds, j);
          if (j !== i && (k === "box" || k === "media") && inside(r, q) && (best < 0 || area(q) < area(nth(local, best)))) best = j;
        });
        return best;
      });
      const colourOf = sampler(el, px, o.patch ?? "#000");
      const patches = local.map((r, i) => {
        if (nth(parent, i) < 0) return null;
        const d = document.createElement("div");
        d.className = "swarm-abs";
        d.style.background = colourOf(r);
        d.style.display = "none";
        _layer.append(d);
        return d;
      });
      /** the part of item i the picture shows, in the picture's px, or null @param {number} i @param {{ phase: number, p: number }} st @returns {Rect | null} */
      const shownPart = (i, st) => {
        if (st.phase === 0) return null;
        const kind = nth(kinds, i);
        let { x, y, w, h } = nth(local, i);
        if (st.phase === 1) {
          const p = st.p;
          if (kind === "box") { if (p < 0.55) return null; }
          else if (kind === "media") { if (p < 0.33) return null; h *= ease.inOut3((p - 0.33) / 0.67); }
          else if (kind === "text") {
            const chars = (nth(items, i).path?.length ?? 2) - 1;
            w *= Math.floor(p * chars + 1e-9) / chars;
          } else w *= ease.inOut3(p);
        }
        return w > 0 && h > 0 ? { x, y, w, h } : null;
      };
      /** what of item i is not built yet, given what is shown @param {number} i @param {Rect | null} part @returns {Rect | null} */
      const remainder = (i, part) => {
        const r = nth(local, i);
        if (!part) return r;
        const kind = nth(kinds, i);
        if (kind === "text" || kind === "line") return part.w < r.w ? { x: part.x + part.w, y: r.y, w: r.x + r.w - part.x - part.w, h: r.h } : null;
        if (kind === "media") return part.h < r.h ? { x: r.x, y: part.y + part.h, w: r.w, h: r.y + r.h - part.y - part.h } : null;
        return null;
      };
      /** @param {Rect} a @param {Rect} b @returns {Rect | null} */
      const meet = (a, b) => {
        const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
        const w = Math.min(a.x + a.w, b.x + b.w) - x, h = Math.min(a.y + a.h, b.y + b.h) - y;
        return w > 0 && h > 0 ? { x, y, w, h } : null;
      };
      let last = "";
      /** @param {ReturnType<typeof plan>} P @param {number} t */
      const write = (P, t) => {
        const rest = t < P.start ? under : under + (1 - under) * clamp((t - P.end) / Math.max(1e-6, settle));
        const parts = local.map((_, i) => shownPart(i, t < P.start ? { phase: 0, p: 0 } : P.itemAt(i, t)));
        patches.forEach((d, i) => {
          if (!d) return;
          const pp = parts[nth(parent, i)] ?? null;
          const rem = pp && rest < 1 ? remainder(i, parts[i] ?? null) : null;
          const r = rem && pp ? meet(rem, pp) : null;
          const v = r ? "" : "none";
          if (d.style.display !== v) d.style.display = v;
          if (r) {
            d.style.transform = `translate(${(px.x + r.x).toFixed(2)}px, ${(px.y + r.y).toFixed(2)}px)`;
            d.style.width = `${r.w.toFixed(2)}px`;
            d.style.height = `${r.h.toFixed(2)}px`;
          }
        });
        if (t >= P.start && rest >= 1) {
          if (last !== "") {
            last = "";
            el.style.removeProperty("mask");
            el.style.removeProperty("-webkit-mask");
            if (own.mask) el.style.setProperty("mask", own.mask);
            if (own.webkit) el.style.setProperty("-webkit-mask", own.webkit);
          }
          return;
        }
        /** @type {string[]} */
        const layers = [];
        if (rest > 0) layers.push(`linear-gradient(rgba(0,0,0,${rest.toFixed(3)}), rgba(0,0,0,${rest.toFixed(3)})) 0 0 / 100% 100% no-repeat`);
        for (const r of parts) {
          if (!r) continue;
          layers.push(`linear-gradient(#000, #000) ${r.x.toFixed(2)}px ${r.y.toFixed(2)}px / ${r.w.toFixed(2)}px ${r.h.toFixed(2)}px no-repeat`);
        }
        const v = layers.length ? layers.join(", ") : "linear-gradient(transparent, transparent)";
        if (v !== last) {
          last = v;
          el.style.setProperty("mask", v);
          el.style.setProperty("-webkit-mask", v);
        }
      };
      return { items, els: items.map(() => el), fonts: items.map(() => null), write };
    }),
  );
}
