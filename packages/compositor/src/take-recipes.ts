// Recipes whose material is a recording made with `make --states`. The model
// names WHAT to show — actions of the take (`a3`, as `open-take states`
// numbers them) and an element of a saved screen (`e32`) — and the program
// owns everything else: where the recording starts and ends and which idle
// stretches it cuts, the cursor (open-take's travel rules), the switch between
// recording and saved screen at a moment they match, how big a lifted element
// grows and where it goes (clear of what the action changes), how long it
// holds (reading time), and the curves. Scenes of one take continue each
// other: the recording's clock and the cursor carry from scene to scene.

import type { LaunchIssue } from "./launch-types";
import { buildLegs, cursorPos, stageCamera } from "./math";
import { estimateMotionReadingSeconds } from "./motion-quality";
import type {
  MotionGroupLayer,
  MotionKeyframe,
  MotionLayer,
  MotionScene,
  MotionTrack,
} from "./motion-types";
import { planComposition } from "./plan";
import { changedBoxes, contentOf, diffStates, matchStates, subtree } from "./state-diff";
import type { StateIndex } from "./state-index";
import {
  type CaptureEvent,
  type CaptureLog,
  DEFAULT_CAMERA,
  type TakeComposition,
  type Pt as TakePt,
} from "./types";

/** A recording and its saved screens, as the brief's `take` names it. */
export type TakeMaterial = {
  /** the take folder, relative to the brief (asset paths are built from it) */
  path: string;
  capture: CaptureLog;
  states: Map<string, StateIndex>;
};
/** Reads a take for the brief (the runtime reads files relative to it). */
export type TakeLoader = (path: string) => TakeMaterial | string;

/** Play recorded actions: from `from` through `to` (default `from`), until
 *  the last one's result has settled. Idle stretches between them are cut,
 *  so every cut lands on the next action. */
export type ProofRecipe = {
  recipe: "proof";
  id: string;
  take: string;
  from: string;
  to?: string;
};
/** Lift an element out of the screen an action left behind: it rises out of
 *  its page, big and sharp, while the page dims; with `change`, a later
 *  action's change to it happens in place (the page behind follows); then it
 *  goes home and the recording carries on. */
export type LiftRecipe = {
  recipe: "lift";
  id: string;
  take: string;
  after: string;
  element: string;
  change?: string;
};
export type TakeRecipe = ProofRecipe | LiftRecipe;
export const TAKE_RECIPES = ["proof", "lift"] as const;

type Pt = TakePt;
type Box = [number, number, number, number];
/** Where the film left a take: its recording's clock and its cursor. */
type Tape = { clockS: number; cursor: Pt };
export type TakeRecipeContext = {
  design: { width: number; height: number };
  loader?: TakeLoader;
  /** per take: where the previous scene of it left the recording */
  tapes: Map<string, Tape>;
};

// ── craft constants (program-owned; tuned by eye) ───────────────────────────
/** the cursor is seen before it moves */
const LEAD_S = 0.6;
/** idle recording longer than this between two shown actions is cut */
const IDLE_CUT_S = 1.5;
/** a switch between recording and saved screen: a dissolve this long */
const HANDOFF_S = 0.2;
const LIFT_S = 0.9,
  RETURN_S = 0.9,
  CHANGE_S = 0.15,
  DIM = 0.38;
const RIPPLE_S = 0.45;
/** the take's camera and cursor are sampled at the film's frame rate */
const SAMPLE_HZ = 60;

/** The take's own direction of a recording — the camera and the cursor the
 *  take renderer draws: the director framing every action from the event log
 *  (lead, push, hold, release, pull-outs for page-wide changes) with the
 *  springs Pascal tuned, and the cursor's travel. The plan's per-step zoom
 *  overrides are dropped: in a film the program frames every action itself.
 *  One per capture log. */
const directions = new WeakMap<
  CaptureLog,
  {
    comp: TakeComposition;
    cam: ReturnType<typeof stageCamera>;
    legs: ReturnType<typeof buildLegs>;
    /** per action (its index in the log): when the camera is done looking at
     *  its result, where cause and effect were split */
    looks: Map<number, number>;
  }
>();
export function directTake(log: CaptureLog, states?: Map<string, StateIndex>) {
  let d = directions.get(log);
  if (!d) {
    const looks = new Map<number, number>();
    const free = { ...log, events: causeThenEffect(log, states, looks) } as CaptureLog;
    const comp = planComposition(free, { output: { width: 1920, height: 1080, fps: SAMPLE_HZ } });
    d = { comp, cam: stageCamera(comp), legs: buildLegs(comp), looks };
    directions.set(log, d);
  }
  return d;
}

const kf = (atS: number, value: number, easing?: MotionKeyframe["easing"]): MotionKeyframe => ({
  atS: Math.round(atS * 1000) / 1000,
  value,
  ...(easing ? { easing } : {}),
});
const track = (property: MotionTrack["property"], ...keyframes: MotionKeyframe[]): MotionTrack => ({
  property,
  keyframes,
});
const error = (path: string, message: string): LaunchIssue => ({
  severity: "error",
  path,
  message,
});

/** `a3` → the 3rd recorded action; otherwise a unique plan label. */
function resolveAction(
  take: TakeMaterial,
  ref: unknown,
  path: string,
  issues: LaunchIssue[],
): { event: CaptureEvent; index: number } | undefined {
  const events = take.capture.events;
  if (typeof ref !== "string" || !ref.trim()) {
    issues.push(error(path, 'must name an action: "a3" (as `open-take states` numbers them)'));
    return undefined;
  }
  const n = /^a(\d+)$/.exec(ref.trim());
  if (n) {
    const index = Number(n[1]) - 1;
    const event = events[index];
    if (!event) {
      issues.push(
        error(path, `${ref}: the take has ${events.length} actions (a1–a${events.length})`),
      );
      return undefined;
    }
    return { event, index };
  }
  const hits = events.flatMap((event, index) => (event.sel === ref ? [{ event, index }] : []));
  if (hits.length === 1) return hits[0];
  issues.push(
    error(
      path,
      hits.length
        ? `${JSON.stringify(ref)} names ${hits.length} actions — use a1…a${events.length}`
        : `no action ${JSON.stringify(ref)} in the take — use a1…a${events.length} (\`open-take states\`)`,
    ),
  );
  return undefined;
}

/** The saved screen an action left behind, if it re-renders like the recording. */
function stateAfter(
  take: TakeMaterial,
  event: CaptureEvent,
  ref: string,
  path: string,
  issues: LaunchIssue[],
): StateIndex | undefined {
  if (!take.capture.states) {
    issues.push(
      error(path, `${take.path} has no saved screens — record it with \`make --states\``),
    );
    return undefined;
  }
  const state = event.state ? take.states.get(event.state) : undefined;
  if (!state) {
    const moving = take.capture.states.items.some((i) => i.id === event.state && i.moving);
    issues.push(
      error(
        path,
        moving
          ? `the page was still moving after ${ref} (${event.state} not saved) — show that moment with a proof`
          : `${ref} left no saved screen behind`,
      ),
    );
    return undefined;
  }
  if (state.fidelity && !state.fidelity.ok) {
    issues.push(
      error(
        path,
        `${state.id} (after ${ref}) does not re-render like the recording (${state.fidelity.psnr.toFixed(1)} dB) — show this moment with a proof`,
      ),
    );
    return undefined;
  }
  return state;
}

/** Where the cursor is when an action is done. */
const endPoint = (e: CaptureEvent): Pt => (e.kind === "drag" ? e.to : { x: e.x, y: e.y });

/** The page's frame in the design: laid out 1:1 in page CSS px inside a group
 *  scaled to fit (contain). */
function pageScale(take: TakeMaterial, design: { width: number; height: number }): number {
  const { w, h } = take.capture.viewport;
  return Math.min(design.width / w, design.height / h);
}

function loadTake(
  raw: unknown,
  path: string,
  ctx: TakeRecipeContext,
  issues: LaunchIssue[],
): TakeMaterial | undefined {
  if (typeof raw !== "string" || !raw.trim()) {
    issues.push(error(path, "must name a take folder (<name>.take), relative to the brief"));
    return undefined;
  }
  if (!ctx.loader) {
    issues.push(error(path, "take recipes need the take on disk — compose the brief from a file"));
    return undefined;
  }
  const take = ctx.loader(raw);
  if (typeof take === "string") {
    issues.push(error(path, take));
    return undefined;
  }
  return take;
}

type Built = { scenes: MotionScene[] } | undefined;

export function buildTakeRecipe(
  raw: Record<string, unknown>,
  path: string,
  ctx: TakeRecipeContext,
  issues: LaunchIssue[],
): Built {
  const allowed =
    raw.recipe === "proof"
      ? ["recipe", "id", "take", "from", "to"]
      : ["recipe", "id", "take", "after", "element", "change"];
  for (const key of Object.keys(raw))
    if (!allowed.includes(key)) issues.push(error(`${path}.${key}`, "unsupported recipe field"));
  if (typeof raw.id !== "string" || !raw.id.trim()) {
    issues.push(error(`${path}.id`, "must be a non-empty string"));
    return undefined;
  }
  const take = loadTake(raw.take, `${path}.take`, ctx, issues);
  if (!take) return undefined;
  return raw.recipe === "proof"
    ? buildProof(raw as ProofRecipe, take, path, ctx, issues)
    : buildLift(raw as LiftRecipe, take, path, ctx, issues);
}

// ── proof ──────────────────────────────────────────────────────────────────

function buildProof(
  r: ProofRecipe,
  take: TakeMaterial,
  path: string,
  ctx: TakeRecipeContext,
  issues: LaunchIssue[],
): Built {
  const from = resolveAction(take, r.from, `${path}.from`, issues);
  const to = r.to === undefined ? from : resolveAction(take, r.to, `${path}.to`, issues);
  if (!from || !to) return undefined;
  if (to.index < from.index) {
    issues.push(error(`${path}.to`, `${r.to} comes before ${r.from} in the recording`));
    return undefined;
  }
  const events = take.capture.events.slice(from.index, to.index + 1);
  const { w: vw, h: vh } = take.capture.viewport;
  const direction = directTake(take.capture, take.states);
  const { cam, legs, comp } = direction;
  // an action's result has settled when the saved screen after it was taken;
  // a moment the page was still moving at never counts (its time says only
  // that the page did not go quiet) — then a reading beat after the action
  const moving = new Set(take.capture.states?.items.filter((i) => i.moving).map((i) => i.id));
  // …and a shot runs until the camera has shown it (the look at the result)
  const settledAt = (e: CaptureEvent): number => {
    const settled =
      e.state && take.states.has(e.state) && !moving.has(e.state)
        ? take.states.get(e.state)!.tMs / 1000
        : (e.tMs + ("durationMs" in e ? e.durationMs : 0)) / 1000 + 1.2;
    return Math.max(settled, direction.looks.get(take.capture.events.indexOf(e)) ?? 0);
  };
  const endS = settledAt(events.at(-1)!);
  // when the cursor leaves for an action (the take's own travel leg)
  const departOf = (e: CaptureEvent): number => {
    const arrive = e.tMs / 1000;
    const leg = legs.find((l) => !l.drag && Math.abs(l.t1 - arrive) < 0.05);
    return leg ? leg.t0 : arrive - 0.6;
  };

  // Where the recording starts: a beat before the cursor leaves for the first
  // action — or, if the film left this take just before, right there (a
  // continuous shot across the scene change).
  // never before the page it acts on has settled (the last saved screen
  // before it — a page change, a wait) nor inside the previous action
  const before = from.index > 0 ? take.capture.events[from.index - 1] : undefined;
  const settledScreen = Math.max(
    0,
    ...[...take.states.values()]
      .map((st) => st.tMs / 1000)
      .filter((t) => t <= from.event.tMs / 1000),
  );
  const floorS = Math.max(
    settledScreen,
    before ? (before.tMs + ("durationMs" in before ? before.durationMs : 0)) / 1000 : 0,
  );
  let startS = Math.max(0, floorS, departOf(from.event) - LEAD_S);
  const tape = ctx.tapes.get(take.path);
  if (tape && tape.clockS <= startS && startS - tape.clockS < IDLE_CUT_S) startS = tape.clockS;

  // The recording in shots. An idle stretch between two actions is cut out
  // only where the cut lands on a NEW framing — the camera somewhere else, or
  // much closer or wider; a cut inside one framing reads as the video
  // skipping (Pascal, 2026-09-18), so then the stretch stays.
  type Shot = { fromS: number; toS: number };
  const shots: Shot[] = [];
  let shotStart = startS;
  for (let i = 0; i < events.length - 1; i++) {
    const done = settledAt(events[i]!);
    const resume = departOf(events[i + 1]!) - LEAD_S;
    if (resume - done > IDLE_CUT_S && newFraming(cam.at(done), cam.at(resume))) {
      shots.push({ fromS: shotStart, toS: done });
      shotStart = resume;
    }
  }
  shots.push({ fromS: shotStart, toS: endS });

  const s = cam.rest;
  const radius = comp.framing.cornerRadius / s;
  const shadow = comp.framing.shadow;
  const scenes: MotionScene[] = shots.map((shot, k) => {
    const id = shots.length > 1 ? `${r.id}-${k + 1}` : r.id;
    const dur = shot.toS - shot.fromS;
    // the take's camera and cursor, sampled at the film's rate: the director
    // Pascal tuned for takes frames every action (lead, push, hold, release)
    const camX: MotionKeyframe[] = [],
      camY: MotionKeyframe[] = [],
      camS: MotionKeyframe[] = [],
      curX: MotionKeyframe[] = [],
      curY: MotionKeyframe[] = [];
    const n = Math.max(2, Math.ceil(dur * SAMPLE_HZ) + 1);
    for (let i = 0; i < n; i++) {
      const f = Math.min(dur, i / SAMPLE_HZ);
      const clock = shot.fromS + f;
      const c = cam.at(clock);
      camX.push(kf(f, round2((vw / 2 - c.center.x) * c.scale)));
      camY.push(kf(f, round2((vh / 2 - c.center.y) * c.scale)));
      camS.push(kf(f, Math.round(c.scale * 10000) / 10000));
      const p = cursorPos(clock, legs, comp);
      curX.push(kf(f, round2(p.x - vw / 2)));
      curY.push(kf(f, round2(p.y - vh / 2)));
    }
    const ripples: MotionLayer[] = [];
    for (const e of events) {
      const at = e.tMs / 1000 - shot.fromS;
      if (at < 0 || at > dur) continue;
      if (e.kind === "scroll" || e.kind === "look" || e.kind === "press" || e.kind === "hover")
        continue;
      ripples.push(
        offset(ripple(`${id}-ripple-${ripples.length + 1}`, at, { x: e.x, y: e.y }), vw, vh),
      );
    }
    const camera: MotionGroupLayer = {
      id: `${id}-camera`,
      type: "group",
      camera: true,
      animations: [
        track("x", ...simplify(camX)),
        track("y", ...simplify(camY)),
        track("scaleX", ...simplify(camS, 1e-4)),
        track("scaleY", ...simplify(camS, 1e-4)),
      ],
      children: [
        // the take's framed screen: rounded, lifted off the backdrop
        {
          id: `${id}-shadow`,
          type: "rect",
          width: vw,
          height: vh,
          radius,
          fill: "#000000",
          shadow: {
            color: shadow.color,
            blur: shadow.blur / s,
            offsetX: shadow.offset.x / s,
            offsetY: shadow.offset.y / s,
          },
        },
        {
          id: `${id}-screen`,
          type: "group",
          width: vw,
          height: vh,
          clip: true,
          radius,
          children: [
            {
              id: `${id}-rec`,
              type: "video",
              asset: `${take.path}/capture.mp4`,
              take: `${take.path}/capture.json`,
              width: vw,
              height: vh,
              trimStartS: round(shot.fromS),
              durationS: round(dur),
            },
          ],
        },
        ...ripples,
        {
          id: `${id}-cursor`,
          type: "cursor",
          animations: [track("x", ...simplify(curX)), track("y", ...simplify(curY))],
        },
      ],
    };
    return {
      id,
      type: "motion",
      durationS: round(dur),
      transition: { type: "cut" },
      layers: [camera],
    } satisfies MotionScene;
  });
  ctx.tapes.set(take.path, { clockS: endS, cursor: cursorPos(endS, legs, comp) });
  return { scenes };
}

/** Cause, then effect. The take's director frames an action together with
 *  what it changed; when the two sit too far apart to share a frame (a slider
 *  in a side panel that re-frames the stage), a take frames the change and
 *  loses the hand. A film shows the hand through the action, THEN looks at
 *  the result: the action is framed on its own, and a `look` at the change
 *  follows as the action completes. The plan's zoom overrides are dropped. */
function causeThenEffect(
  log: CaptureLog,
  states: Map<string, StateIndex> | undefined,
  looks: Map<number, number>,
): CaptureEvent[] {
  const { w: vw, h: vh } = log.viewport;
  const out: CaptureEvent[] = [];
  log.events.forEach((raw, i) => {
    const { zoom: _zoom, ...e } = raw;
    const hand: Rect =
      e.box ??
      (e.kind === "drag"
        ? {
            x: Math.min(e.x, e.to.x) - 20,
            y: Math.min(e.y, e.to.y) - 20,
            w: Math.abs(e.to.x - e.x) + 40,
            h: Math.abs(e.to.y - e.y) + 40,
          }
        : { x: e.x - 20, y: e.y - 20, w: 40, h: 40 });
    // what the action changed, apart from the control itself (a field's own
    // text is the hand, not the result)
    const changes = domChanges(log, states, e).filter((r) => !overlaps(r, hand));
    if (e.effectBox && !overlaps(e.effectBox, hand)) changes.push(e.effectBox);
    // the frame a push on the hand shows (the director's tightest framing)
    const cx = hand.x + hand.w / 2,
      cy = hand.y + hand.h / 2;
    const frame: Rect = {
      x: cx - vw / (2 * DEFAULT_CAMERA.maxScale),
      y: cy - vh / (2 * DEFAULT_CAMERA.maxScale),
      w: vw / DEFAULT_CAMERA.maxScale,
      h: vh / DEFAULT_CAMERA.maxScale,
    };
    // by area: a location pill ticking over far away is not where to look
    const area = (r: Rect) => r.w * r.h;
    const total = changes.reduce((sum, r) => sum + area(r), 0);
    const outside = changes.reduce((sum, r) => sum + area(r) - intersection(r, frame), 0);
    const effect = changes
      .filter((r) => area(r) >= 0.08 * total)
      .reduce<Rect | undefined>((u, r) => unionBox(u, r), undefined);
    if (!effect || total <= 0 || outside / total < 0.35) {
      out.push(e as CaptureEvent);
      return;
    }
    // the result is mostly out of the hand's shot: the hand first, then a look
    const { effectBox: _effect, changeCoverage: _coverage, ...action } = e;
    out.push({ ...action, box: e.box ?? hand } as CaptureEvent);
    // the hand's shot holds long enough to read (the director's min-hold —
    // shorter, and it would drop the push as a flinch), then the camera looks
    const at = Math.max(
      e.tMs + ("durationMs" in e ? e.durationMs : 0) + 250,
      e.tMs + DEFAULT_CAMERA.minHoldMs + 150,
    );
    // a result the viewer must read: longer when nothing comes after it
    const next = log.events[i + 1];
    const hold = next ? Math.min(1400, next.tMs - 300 - at) : 2200;
    if (hold < 400) return;
    looks.set(i, (at + hold) / 1000);
    out.push({
      kind: "look",
      x: effect.x + effect.w / 2,
      y: effect.y + effect.h / 2,
      box: effect,
      tMs: at,
      durationMs: hold,
      sel: `${e.sel ?? e.kind} → its result`,
    });
  });
  return out;
}

type Rect = { x: number; y: number; w: number; h: number };
function intersection(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}
const overlaps = (a: Rect, b: Rect) => intersection(a, b) > 0;
function unionBox(a?: Rect, b?: Rect): Rect | undefined {
  if (!a || !b) return a ?? b;
  const x = Math.min(a.x, b.x),
    y = Math.min(a.y, b.y);
  return {
    x,
    y,
    w: Math.max(a.x + a.w, b.x + b.w) - x,
    h: Math.max(a.y + a.h, b.y + b.h) - y,
  };
}

/** Where an action changed the page, read off the saved screens before and
 *  after it: every element it added, changed or moved (a page-sized wrapper
 *  resizing says nothing about where to look). The frame diff sees only the
 *  biggest patch of pixels — typing into a field — and misses the result the
 *  field computes on the other side of the page. */
function domChanges(
  log: CaptureLog,
  states: Map<string, StateIndex> | undefined,
  e: CaptureEvent,
): Rect[] {
  if (!states || !e.state) return [];
  const after = states.get(e.state);
  if (!after) return [];
  let before: StateIndex | undefined;
  for (const item of log.states?.items ?? [])
    if (item.tMs <= e.tMs && states.has(item.id)) before = states.get(item.id);
  if (!before || before === after || before.url !== after.url) return [];
  const page = log.viewport.w * log.viewport.h;
  const out: Rect[] = [];
  for (const c of diffStates(before, after)) {
    const b = c.kind === "removed" ? c.a.box : c.b.box;
    if (b[2] <= 0 || b[3] <= 0 || b[2] * b[3] > 0.5 * page) continue;
    out.push({ x: b[0], y: b[1], w: b[2], h: b[3] });
  }
  return out;
}

/** Two framings of the take's camera differ enough for a cut between them to
 *  read as a new shot: closer or wider by a quarter, or looking a quarter of
 *  the frame away. */
function newFraming(a: { scale: number; center: Pt }, b: { scale: number; center: Pt }): boolean {
  if (Math.abs(Math.log(a.scale / b.scale)) > Math.log(1.25)) return true;
  const moved = Math.hypot(a.center.x - b.center.x, a.center.y - b.center.y);
  return moved * Math.min(a.scale, b.scale) > 0.25 * 1920;
}

/** Drop keyframes a straight line already gives, within `tol` everywhere
 *  (Ramer–Douglas–Peucker): a sampled camera holds still, or moves on one
 *  curve, for most of a shot. */
function simplify(keys: MotionKeyframe[], tol = 0.05): MotionKeyframe[] {
  if (keys.length <= 2) return keys;
  const keep = new Array<boolean>(keys.length).fill(false);
  keep[0] = keep[keys.length - 1] = true;
  const stack: [number, number][] = [[0, keys.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop()!;
    const a = keys[i]!,
      b = keys[j]!;
    let worst = -1,
      at = -1;
    for (let k = i + 1; k < j; k++) {
      const u = (keys[k]!.atS - a.atS) / (b.atS - a.atS);
      const line = (a.value as number) + ((b.value as number) - (a.value as number)) * u;
      const off = Math.abs((keys[k]!.value as number) - line);
      if (off > worst) {
        worst = off;
        at = k;
      }
    }
    if (worst > tol) {
      keep[at] = true;
      stack.push([i, at], [at, j]);
    }
  }
  return keys.filter((_, k) => keep[k]);
}
const round2 = (n: number) => Math.round(n * 100) / 100;

/** A click lands: a ring spreads from the point and fades (the take's ripple). */
function ripple(id: string, atS: number, p: Pt): MotionLayer {
  const grow = (property: "width" | "height") =>
    track(property, kf(0, 24), kf(atS, 24), kf(atS + RIPPLE_S, 144, "ease-out"));
  return {
    id,
    type: "ellipse",
    x: p.x,
    y: p.y,
    width: 24,
    height: 24,
    fill: "#ffffff00",
    stroke: "#ffffff",
    strokeWidth: 4,
    opacity: 0,
    animations: [
      grow("width"),
      grow("height"),
      track(
        "opacity",
        kf(0, 0),
        kf(Math.max(atS, 1e-3), 0.59, "step"),
        kf(atS + RIPPLE_S, 0, "ease-out"),
      ),
    ],
  };
}

/** Page CSS px → the page group's centred coordinates (x/y and every x/y
 *  keyframe shift by half the page). */
function offset(layer: MotionLayer, w: number, h: number): MotionLayer {
  const dx = -w / 2,
    dy = -h / 2;
  return {
    ...layer,
    x: (layer.x ?? 0) + dx,
    y: (layer.y ?? 0) + dy,
    ...(layer.animations
      ? {
          animations: layer.animations.map((t) =>
            t.property === "x" || t.property === "y"
              ? {
                  ...t,
                  keyframes: t.keyframes.map((k) => ({
                    ...k,
                    value: (k.value as number) + (t.property === "x" ? dx : dy),
                  })),
                }
              : t,
          ),
        }
      : {}),
  } as MotionLayer;
}

const round = (n: number) => Math.round(n * 1000) / 1000;

// ── lift ───────────────────────────────────────────────────────────────────

function buildLift(
  r: LiftRecipe,
  take: TakeMaterial,
  path: string,
  ctx: TakeRecipeContext,
  issues: LaunchIssue[],
): Built {
  const after = resolveAction(take, r.after, `${path}.after`, issues);
  if (!after) return undefined;
  const sa = stateAfter(take, after.event, r.after, `${path}.after`, issues);
  if (!sa) return undefined;
  const el = sa.elements.find((e) => e.id === r.element);
  if (!el) {
    issues.push(
      error(
        `${path}.element`,
        `${sa.id} (after ${r.after}) has no element ${JSON.stringify(r.element)}`,
      ),
    );
    return undefined;
  }
  let sc: StateIndex | undefined;
  let changeEvent: CaptureEvent | undefined;
  let elC: string | undefined;
  if (r.change !== undefined) {
    const change = resolveAction(take, r.change, `${path}.change`, issues);
    if (!change) return undefined;
    if (change.index <= after.index) {
      issues.push(error(`${path}.change`, `${r.change} must come after ${r.after}`));
      return undefined;
    }
    sc = stateAfter(take, change.event, r.change, `${path}.change`, issues);
    if (!sc) return undefined;
    elC = matchStates(sa, sc).get(el.id);
    if (!elC) {
      issues.push(error(`${path}.change`, `${el.id} of ${sa.id} is gone after ${r.change}`));
      return undefined;
    }
    changeEvent = change.event;
  }

  const { w: vw, h: vh } = take.capture.viewport;
  const s = pageScale(take, ctx.design);
  const W = ctx.design.width,
    H = ctx.design.height;
  // the element with a little of its surroundings (border, corners, shadow)
  const pad = 8;
  const crop = {
    x: Math.max(0, el.box[0] - pad),
    y: Math.max(0, el.box[1] - pad),
    width: 0,
    height: 0,
  };
  crop.width = Math.min(vw, el.box[0] + el.box[2] + pad) - crop.x;
  crop.height = Math.min(vh, el.box[1] + el.box[3] + pad) - crop.y;
  const rest = { x: crop.x + crop.width / 2 - vw / 2, y: crop.y + crop.height / 2 - vh / 2 };

  // how big: the element fills about half the frame's height or 40 % of its
  // width, whichever comes first — more than a nudge, never a blow-up
  const k = Math.min(
    3.2,
    Math.max(1.15, Math.min((0.52 * H) / (crop.height * s), (0.4 * W) / (crop.width * s))),
  );
  const halfW = (crop.width * s * k * 1.03) / 2,
    halfH = (crop.height * s * k * 1.03) / 2;
  // where: clear of everything the actions change on the page (their DOM
  // changes and their pixel changes), on the side the element already is
  const avoid: Box[] = [];
  const toFrame = (b: Box): Box => [(b[0] - vw / 2) * s, (b[1] - vh / 2) * s, b[2] * s, b[3] * s];
  if (sc) for (const b of changedBoxes(sa, sc, el.id)) avoid.push(toFrame(b));
  for (const e of [after.event, changeEvent])
    if (e?.effectBox)
      avoid.push(toFrame([e.effectBox.x, e.effectBox.y, e.effectBox.w, e.effectBox.h]));
  const margin = 64;
  const restFrame = { x: rest.x * s, y: rest.y * s };
  let best = { x: 0, y: 0, score: Infinity };
  for (const fx of [-0.25, 0, 0.25])
    for (const fy of [-0.12, 0, 0.12]) {
      const x = Math.max(-W / 2 + margin + halfW, Math.min(W / 2 - margin - halfW, fx * W));
      const y = Math.max(-H / 2 + margin + halfH, Math.min(H / 2 - margin - halfH, fy * H));
      const card: Box = [x - halfW, y - halfH, halfW * 2, halfH * 2];
      let covered = 0;
      for (const b of avoid) covered += overlap(card, b);
      const score =
        covered / (halfW * halfH * 4) +
        0.15 * (Math.hypot(x - restFrame.x, y - restFrame.y) / W) +
        0.05 * Math.abs(fy) * 4;
      if (score < best.score) best = { x, y, score };
    }
  const target = { x: best.x / s, y: best.y / s };

  // time: in on the recording, lift, read, change, read, home, out on the recording
  const liftAt = HANDOFF_S + 0.1;
  const landed = liftAt + LIFT_S;
  const read = (text: string) => estimateMotionReadingSeconds(text);
  const content = contentOf(sa, el.id);
  let changeAt: number | undefined;
  let backAt: number;
  if (sc && elC) {
    // before a change the viewer only needs what is about to change (and
    // what the element is): that registers the old value; after it, the new
    const insideA = new Set(subtree(sa, el.id).map((e) => e.id));
    const insideC = new Set(subtree(sc, elC).map((e) => e.id));
    const diff = diffStates(sa, sc);
    const label = (e: { text?: string; name?: string }) => e.text || e.name || "";
    const was = diff.flatMap((c) =>
      c.kind !== "added" && insideA.has(c.a.id) ? [label(c.a)] : [],
    );
    const now = diff.flatMap((c) =>
      c.kind !== "removed" && insideC.has(c.b.id) ? [label(c.b)] : [],
    );
    changeAt = landed + clamp(read([content[0] ?? "", ...was].join(" ")), 1.2, 2.2);
    backAt = changeAt + CHANGE_S + clamp(read(now.join(" ") || "changed"), 1.2, 2.2);
  } else backAt = landed + clamp(read(content.slice(0, 12).join(" ")), 1.2, 3);
  const homeAt = backAt + RETURN_S;
  const outAt = homeAt + 0.1;
  const endAt = outAt + HANDOFF_S + 0.1;

  const tSa = sa.tMs / 1000;
  const final = sc ?? sa;
  const tOut = final.tMs / 1000;
  // the cursor where the film left it, when the film left the take right here
  const tape = ctx.tapes.get(take.path);
  const cursorIn = tape && Math.abs(tape.clockS - tSa) < 0.5 ? tape.cursor : endPoint(after.event);
  const cursorOut = changeEvent ? endPoint(changeEvent) : cursorIn;
  const stateLayer = (id: string, st: StateIndex, extra: Partial<MotionLayer>) =>
    ({
      id,
      type: "state",
      state: `${take.path}/states/${st.id}`,
      width: vw,
      height: vh,
      ...extra,
    }) as MotionLayer;
  const visible = (on: number, off?: number, fadeIn = 0): MotionTrack => {
    const keys = [kf(0, 0)];
    if (fadeIn) {
      if (on > 0) keys.push(kf(on, 0));
      keys.push(kf(on + fadeIn, 1, "ease-in-out"));
    } else keys.push(kf(on, 1, "step"));
    if (off !== undefined) keys.push(kf(off, 0, "step"));
    return track("opacity", ...keys);
  };
  const card = (id: string, st: StateIndex, elId: string, opacity: MotionTrack): MotionLayer =>
    ({
      id,
      type: "state",
      state: `${take.path}/states/${st.id}`,
      only: [elId],
      crop,
      width: crop.width,
      height: crop.height,
      shadow: { color: "rgba(0,0,0,0.55)", blur: 26, offsetY: 10 },
      opacity: 0,
      animations: [opacity],
    }) as MotionLayer;

  const layers: MotionLayer[] = [
    // in on the recording's settled frames
    {
      id: `${r.id}-rec-in`,
      type: "video",
      asset: `${take.path}/capture.mp4`,
      take: `${take.path}/capture.json`,
      width: vw,
      height: vh,
      trimStartS: round(Math.max(0, tSa - HANDOFF_S)),
      durationS: HANDOFF_S,
    },
    stateLayer(`${r.id}-page`, sa, { opacity: 0, animations: [visible(0, liftAt, HANDOFF_S)] }),
    // from the lift on, the page has an empty slot where the element was
    stateLayer(`${r.id}-page-slot`, sa, {
      hide: [el.id],
      opacity: 0,
      animations: [visible(liftAt, changeAt !== undefined ? changeAt + CHANGE_S : homeAt)],
    }),
  ];
  if (sc && elC && changeAt !== undefined)
    layers.push(
      stateLayer(`${r.id}-page-slot-after`, sc, {
        hide: [elC],
        opacity: 0,
        animations: [visible(changeAt, homeAt, CHANGE_S)],
      }),
    );
  layers.push(
    // home: the whole page again (the lifted element is back in its place)
    stateLayer(`${r.id}-page-after`, final, { animations: [visible(homeAt)], opacity: 1 }),
    {
      id: `${r.id}-dim`,
      type: "rect",
      width: W / s,
      height: H / s,
      fill: "#000000",
      opacity: 0,
      animations: [
        track(
          "opacity",
          kf(0, 0),
          kf(liftAt, 0),
          kf(liftAt + 0.6, DIM, "ease-out"),
          kf(backAt, DIM),
          kf(homeAt, 0, "ease-in-out"),
        ),
      ],
    },
  );
  const cards: MotionLayer[] = [
    card(
      `${r.id}-lifted`,
      sa,
      el.id,
      sc && changeAt !== undefined
        ? track("opacity", kf(0, 0), kf(liftAt, 1, "step"), kf(changeAt + CHANGE_S, 0, "step"))
        : track("opacity", kf(0, 0), kf(liftAt, 1, "step"), kf(homeAt, 0, "step")),
    ),
  ];
  if (sc && elC && changeAt !== undefined)
    cards.push(
      card(
        `${r.id}-lifted-after`,
        sc,
        elC,
        track(
          "opacity",
          kf(0, 0),
          kf(changeAt, 0),
          kf(changeAt + CHANGE_S, 1, "ease-in-out"),
          kf(homeAt, 0, "step"),
        ),
      ),
    );
  layers.push({
    id: `${r.id}-lift`,
    type: "group",
    x: rest.x,
    y: rest.y,
    children: cards,
    animations: [
      track(
        "x",
        kf(0, rest.x),
        kf(liftAt, rest.x),
        kf(landed, target.x, "swift"),
        kf(backAt, target.x),
        kf(homeAt, rest.x, "glide"),
      ),
      track(
        "y",
        kf(0, rest.y),
        kf(liftAt, rest.y),
        kf(landed, target.y, "swift"),
        kf(backAt, target.y),
        kf(homeAt, rest.y, "glide"),
      ),
      // it lands, then keeps drifting closer while it is read
      ...(["scaleX", "scaleY"] as const).map((p) =>
        track(
          p,
          kf(0, 1),
          kf(liftAt, 1),
          kf(landed, k, "swift"),
          kf(backAt, k * 1.03, "linear"),
          kf(homeAt, 1, "glide"),
        ),
      ),
    ],
  });
  // out on the recording, where it carries on after the change
  layers.push({
    id: `${r.id}-rec-out`,
    type: "video",
    asset: `${take.path}/capture.mp4`,
    take: `${take.path}/capture.json`,
    width: vw,
    height: vh,
    trimStartS: round(tOut),
    startS: round(outAt),
    durationS: round(endAt - outAt),
    opacity: 0,
    animations: [track("opacity", kf(0, 0), kf(outAt, 0), kf(outAt + HANDOFF_S, 1, "ease-in-out"))],
  });
  layers.push({
    id: `${r.id}-cursor`,
    type: "cursor",
    x: cursorIn.x - vw / 2,
    y: cursorIn.y - vh / 2,
    animations: [
      track("x", kf(0, cursorIn.x - vw / 2), kf(outAt, cursorOut.x - vw / 2, "step")),
      track("y", kf(0, cursorIn.y - vh / 2), kf(outAt, cursorOut.y - vh / 2, "step")),
      track(
        "opacity",
        kf(0, 1),
        kf(liftAt, 1),
        kf(liftAt + 0.25, 0, "ease-in"),
        kf(outAt, 0),
        kf(outAt + HANDOFF_S, 1, "ease-out"),
      ),
    ],
  });
  ctx.tapes.set(take.path, { clockS: tOut + (endAt - outAt), cursor: cursorOut });
  return {
    scenes: [
      {
        id: r.id,
        type: "motion",
        durationS: round(endAt),
        transition: { type: "cut" },
        layers: [{ id: `${r.id}-frame`, type: "group", scaleX: s, scaleY: s, children: layers }],
      },
    ],
  };
}

function overlap(a: Box, b: Box): number {
  const x = Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]));
  const y = Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));
  return x * y;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
