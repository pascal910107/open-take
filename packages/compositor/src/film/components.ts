// The component inventory — a material index: every part the component probe
// measured in a shoot's or a take's saved screens (states/<id>/parts.json,
// written by the runtime in the fidelity page — components-probe.ts),
// gathered into one `components.json` beside the log, with what the log knows
// on top of what the page showed:
//
//   - values: what each part holds, field by field, in full — its text, the
//     number in it (with its unit), an input's value apart from its
//     placeholder — each with where it was read (state, element, selector,
//     the shoot's still), so a film can show the product's own values and
//     say where they came from;
//   - relations: what a control changed (the action before a screen acted on
//     it and these parts changed or appeared — seen), what it controls or
//     labels by the page's own markup, what holds what;
//   - provenance: the page each part was on (its URL, whether that host is a
//     local one) and when the screen was saved;
//   - which part the action before a screen acted on, which changed (was →
//     now, or its state: a tab now selected) and which appeared since the
//     screen before it;
//   - tracks: the same part followed through the screens (matchStates), with
//     what it read at each step — the wizard card through its steps, a total
//     rising as a slider moves, a tab turning selected;
//   - where each part would sit fitted to the film's stage, and how big its
//     text reads on a phone as part of the whole screen and fitted.
//
// Pure Node: no browser. Everything here is measurement or arithmetic on it.
// Parts are in the page's own order; nothing in the file says which part a
// film uses, and none is singled out.
//
// `exampleSource` writes a small module that lifts the part it is named and
// moves it from where it sat to its fit — `open-take components --snippet
// <ref>`, for a part the film's author names.

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { contentOf, matchStates, subtree, visibleLabel } from "../state-diff";
import { readStateIndex, type StateElement, type StateIndex } from "../state-index";
import type { CaptureLog } from "../types";
import type { PartCandidate, PartFields, PartKind, PartsFile } from "./components-probe";
import { PHONE_W } from "./probe-text";

type Box = [number, number, number, number];

// --- the file -------------------------------------------------------------------

/** One value a part holds, as the page showed it. */
export type ComponentValue = {
  /** as the page had it, in full */
  text: string;
  /** the number in it, read as written ("NT$4,466" → 4466; "18.5個月" → 18.5) */
  value?: number;
  /** what stands with that number ("NT$", "個月", "%") */
  unit?: string;
  /** read from a parts.json measured before the probe kept full text: the
   *  80-character label it had — `open-take components` measures it again */
  capped?: true;
  /** where it was read: the saved screen, the element (index.json id), its
   *  CSS path in state.html, and the shoot's still of that moment (relative
   *  to components.json) */
  source: { state: string; eid: string; selector?: string; shot?: string };
};

/** How one part bears on another (a ref, `<state>:<element id>`):
 *  - controls: its markup says so (aria-controls — a tab and its panel);
 *  - changes: the action before a screen acted on it and `to` changed,
 *    restyled or appeared on that screen (seen in the log and the diff);
 *  - labels: its text names `to` (a field's label and its input; the
 *    heading aria-labelledby points at);
 *  - contains: `to` is the next part inside it.
 *  `by` is how it is known: seen (the action log and the screens' diff),
 *  markup (the page's own attributes) or layout (what holds what). */
export type ComponentRelation = {
  kind: "controls" | "changes" | "labels" | "contains";
  to: string;
  by: "seen" | "markup" | "layout";
};

/** Where a part was: the saved screen, the page's URL, when the screen was
 *  saved (index.json's file time) and on the capture's clock. `local`: the
 *  URL's host is this machine (localhost, 127.x, ::1, *.local, a file) — the
 *  data on it may be a local seed rather than the live product's. */
export type ComponentProvenance = {
  state: string;
  url?: string;
  capturedAt?: string;
  tMs?: number;
  local?: true;
};

/** One part of one saved screen. Refs are `<state>:<element id>`, as
 *  `open-take states` names elements and as lift() takes them. */
export type ComponentEntry = {
  ref: string;
  state: string;
  el: string;
  kind: PartKind;
  sub?: PartCandidate["sub"];
  primary?: true;
  /** what it reads, for a glance (≤ 80 characters); `values` has it in full */
  label: string;
  /** what it holds, by field: text (its visible text), number (the number in
   *  it), label (a stat's or a field's words beside its value), value /
   *  placeholder / min / max / checked (an input's own), name (an accessible
   *  name that is not its text — an icon-only button's) */
  values: Record<string, ComponentValue>;
  relations: ComponentRelation[];
  provenance: ComponentProvenance;
  selector: string;
  /** layout box, the screen's CSS px */
  box: Box;
  /** the text's own extent (text kinds) */
  ink?: Box;
  /** the part it sits inside (a ref) */
  inside?: string;
  /** its content children in order (refs) — what an assemble acts on */
  parts?: string[];
  /** a group's members (refs) */
  members?: string[];
  axis?: PartCandidate["axis"];
  field?: string;
  input?: string;
  /** the ARIA / form state it shows (selected, pressed, expanded, current,
   *  disabled, open), as the probe read it */
  shows?: Record<string, string>;
  look: PartCandidate["look"];
  facts: PartCandidate["facts"] & {
    /** the action before this screen acted on it (or on a control inside it) */
    acted?: true;
    /** its text since the screen before: "was → now" (each side ≤ 40
     *  characters; the steps of its track have them in full) */
    changed?: string;
    /** its state or colour since the screen before, its text the same:
     *  "selected: – → true", "fill #ffffff → #0a7f5a" */
    restyled?: string;
    /** its box moved or resized since the screen before (text the same) */
    moved?: true;
    /** not on the screen before (a result card, a toast) */
    appeared?: true;
  };
  /** its text in px on a phone (PHONE_W wide): as part of the whole screen
   *  fitted to the stage, and fitted on its own (`fit`). Arithmetic on its
   *  computed font size (a stat, card, group or field: the largest of the
   *  parts inside it) — not measured on a phone */
  phone?: { asScreen: number; atFit: number };
  /** the largest box of its shape within 70 % × 60 % of the stage, centred —
   *  `k` its scale from the screen, `by` which of its boxes (with lift.pad) */
  fit: { box: Box; k: number; by: "ink" | "box" };
  /** the track it is a step of */
  track?: string;
  /** an earlier screen shows the same part (kind, text and place): its ref */
  repeats?: string;
  /** the same element on the screen before (matchStates, the same kind),
   *  whether it changed or not — a part that stayed but moved is linked
   *  here too */
  before?: string;
  /** its crisp picture (3×, see-through around it), relative to components.json */
  picture?: string;
  noPicture?: string;
  /** the lift() options that reproduce the picture */
  lift: PartCandidate["lift"];
};

export type ComponentState = {
  id: string;
  /** state.html, relative to components.json */
  url: string;
  /** the page it was: its URL, title, when it was saved */
  page?: { url: string; title?: string; capturedAt?: string; tMs?: number; local?: true };
  /** the shoot's still of this moment, relative to components.json */
  shot?: string;
  fidelity?: { ok: boolean; psnr?: number; diffFrac?: number };
  /** the action that led here, as the log has it */
  action?: ComponentAction;
  /** the screen before it in the log (what `changed` / `appeared` compare with) */
  since?: string;
  /** most of the screen is new since the one before (another page): no part is
   *  marked `appeared` */
  newPage?: true;
  medianTextPx?: number;
  /** this screen's components, in `order` */
  components: string[];
  /** why it has none (no parts.json, an unreadable index) */
  unmeasured?: string;
};

export type ComponentAction = {
  kind: string;
  /** the shoot's still name / the plan's selector */
  label?: string;
  /** the element it acted on, a ref in this screen (when it is still there) */
  acted?: string;
  /** …or in the screen before, when this one no longer has it */
  actedBefore?: string;
  /** how that was found: the capture's own match of the action's box
   *  ("capture"), or the element under the action's point ("point") */
  by?: "capture" | "point";
  /** the parts that changed, restyled or appeared on this screen after it
   *  (seen: the log and the screens' diff), apart from the control itself
   *  and what changed only inside it — also when the element acted on is
   *  not a part of its own (a tab drawn as a bare link); in page order */
  changes?: string[];
};

export type ComponentTrack = {
  id: string;
  kind: PartKind;
  /** what it reads at its last step (≤ 60 characters) */
  label: string;
  /** steps whose text, number or state differs from the step before */
  changes: number;
  /** each step: its text in full, the number in it, and its state (ARIA /
   *  form state, fill) when it has one */
  steps: {
    state: string;
    ref: string;
    text: string;
    value?: number;
    unit?: string;
    shows?: string;
  }[];
};

/** `components.json` — version 2 (version 1 plus values, relations,
 *  provenance, restyled, track values; the order is the page's). */
export type ComponentsFile = {
  version: 2;
  about: string;
  /** how `components` (and each screen's list) is ordered */
  order: string;
  source: {
    kind: ComponentSourceKind;
    /** the log it was read with, relative to components.json */
    log?: string;
    viewport: { w: number; h: number; dpr?: number };
    /** px of what shows the screens — a shoot's stills (shots.json scale),
     *  a take's recording (its video's width over the viewport's) — per CSS
     *  px of the screen */
    srcRatio?: number;
  };
  stage: { width: number; height: number; phoneWidth: number; phoneScale: number };
  states: ComponentState[];
  components: ComponentEntry[];
  groups: { ref: string; kind: PartKind; axis?: string; members: string[] }[];
  tracks: ComponentTrack[];
  skipped: { ref: string; kind: PartKind; why: string; label?: string }[];
  /** measured: the component probe's time in the page and its pictures, summed */
  ms: { measure: number; pictures: number };
};

const ABOUT =
  "A material index of this product's saved screens: the parts that stand on their own, as the component probe measured them in each restored page (states/<id>/parts.json); what each holds, field by field and in full, with where it was read (values); how parts bear on each other — what an action on one changed, what the markup says one controls or labels, what holds what (relations); the page each was on (provenance); and the same part followed through the screens (tracks). Measurements and arithmetic on them; nothing here says which part a film uses.";

/** The order, in words — printed by the CLI and written into the file. */
export const COMPONENT_ORDER =
  "screens in log order; within a screen, the page's own order (document order) — where to find a part, not a ranking";

const ACTABLE = new Set<PartKind>(["button", "input", "control", "field"]);
/** kinds whose phone size is their largest text inside */
const BLOCK_TEXT = new Set<PartKind>(["stat", "card", "group", "field"]);

// --- the source -------------------------------------------------------------------

export type ComponentSourceKind = "shoot" | "take" | "states" | "state";

/** One saved screen to gather, with the action that led to it. */
export type ComponentSourceState = {
  id: string;
  /** the state's folder (absolute) */
  dir: string;
  fidelity?: ComponentState["fidelity"];
  /** the shoot's still of this moment (absolute) */
  shot?: string;
  action?: {
    kind: string;
    label?: string;
    /** the element acted on, by the capture's own match — in the screen before */
    target?: string;
    /** where the action was, viewport CSS px — of the screen before it
     *  (`before`: a take's anchor) or of this one (`after`: a shoot's still
     *  is taken where the mouse ended) */
    point?: { x: number; y: number; in: "before" | "after" };
  };
};

export type ComponentSource = {
  kind: ComponentSourceKind;
  /** where components.json goes (absolute) */
  root: string;
  /** the log, absolute */
  log?: string;
  /** px of the stills or the recording per CSS px of the screen */
  srcRatio?: number;
  states: ComponentSourceState[];
};

/** a shoot's log, as far as this reads it (runtime/src/shoot.ts) */
type ShotsLog = {
  scale?: number;
  stills?: {
    file?: string;
    name?: string;
    cursor?: { x: number; y: number };
    scroll?: { x: number; y: number };
    action?: string;
    state?: string;
  }[];
  states?: {
    dir?: string;
    items?: { id: string; still?: string; fidelity?: ComponentState["fidelity"] }[];
  };
};

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const readJson = <T>(p: string): T => JSON.parse(readFileSync(p, "utf8")) as T;
/** a take's or shoot's anchor kinds that sit on the thing acted on */
const POINT_KINDS = new Set(["click", "type", "drag", "hover", "move", "look", "dropFiles"]);

/**
 * What `path` is and which saved screens it holds, in log order: a shoot's
 * folder (shots.json), a take's working dir (capture.json — `<name>.take/`),
 * one saved screen (index.json), or a folder of saved screens without a log
 * (a film folder's states/, or that folder itself). Throws with what it
 * found when it is none of these.
 */
export function readComponentSource(path: string): ComponentSource {
  let dir = resolve(path);
  if (!isDir(dir) && /\.json$/i.test(dir)) dir = dirname(dir);
  if (!isDir(dir) && /\.mp4$/i.test(dir) && isDir(dir.replace(/\.mp4$/i, ".take")))
    dir = dir.replace(/\.mp4$/i, ".take");
  if (!isDir(dir)) throw new Error(`components: no folder at ${dir}`);
  if (existsSync(join(dir, "shots.json"))) return shootSource(dir);
  if (existsSync(join(dir, "capture.json"))) return takeSource(dir);
  if (existsSync(join(dir, "index.json")))
    return { kind: "state", root: dir, states: [{ id: basename(dir), dir }] };
  const states = isDir(join(dir, "states")) ? join(dir, "states") : dir;
  const found = readdirSync(states, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(states, d.name, "index.json")))
    .map((d) => {
      const index = readStateIndex(join(states, d.name));
      return {
        id: d.name,
        dir: join(states, d.name),
        tMs: typeof index === "string" ? 0 : index.tMs,
      };
    })
    .sort((a, b) => a.tMs - b.tMs || a.id.localeCompare(b.id));
  if (!found.length)
    throw new Error(
      `components: ${dir} holds no saved screens — give it a shoot's folder (shots.json), a take (its .mp4 or <name>.take/), a saved screen (index.json) or a folder of them`,
    );
  return { kind: "states", root: dir, states: found.map(({ id, dir }) => ({ id, dir })) };
}

function shootSource(dir: string): ComponentSource {
  const log = readJson<ShotsLog>(join(dir, "shots.json"));
  const stills = Array.isArray(log.stills) ? log.stills : [];
  const items = Array.isArray(log.states?.items) ? log.states.items : [];
  const statesDir = join(dir, log.states?.dir || "states");
  let last = -1;
  const states: ComponentSourceState[] = [];
  for (const it of items) {
    const at = stills.findIndex((s) => s.state === it.id || (it.still && s.file === it.still));
    // the action that led here: the last still with one since the screen before
    let act: (typeof stills)[number] | undefined;
    for (let i = last + 1; i <= at; i++) if (stills[i]?.action) act = stills[i];
    if (at >= 0) last = at;
    // the mouse is where the action left it: on what it acted on as the
    // screen before showed it (the still itself is taken once the page has
    // answered, and an answer can move things); the first screen has only itself
    const point =
      act?.cursor && act.action && POINT_KINDS.has(act.action)
        ? {
            x: act.cursor.x - (act.scroll?.x ?? 0),
            y: act.cursor.y - (act.scroll?.y ?? 0),
            in: states.length ? ("before" as const) : ("after" as const),
          }
        : undefined;
    const still = it.still ?? (at >= 0 ? stills[at]?.file : undefined);
    states.push({
      id: it.id,
      dir: join(statesDir, it.id),
      ...(it.fidelity ? { fidelity: it.fidelity } : {}),
      ...(still && existsSync(join(dir, still)) ? { shot: join(dir, still) } : {}),
      ...(act?.action
        ? {
            action: {
              kind: act.action,
              ...(act.name ? { label: act.name } : {}),
              ...(point ? { point } : {}),
            },
          }
        : {}),
    });
  }
  return {
    kind: "shoot",
    root: dir,
    log: join(dir, "shots.json"),
    ...(typeof log.scale === "number" && log.scale > 0 ? { srcRatio: log.scale } : {}),
    states,
  };
}

function takeSource(dir: string): ComponentSource {
  const log = readJson<CaptureLog>(join(dir, "capture.json"));
  const items = (log.states?.items ?? []).filter((it) => !it.moving);
  const statesDir = join(dir, log.states?.dir || "states");
  const states: ComponentSourceState[] = items.map((it) => {
    const e = log.events.find((x) => x.state === it.id);
    const kind = e?.kind ?? "click";
    const point =
      e && POINT_KINDS.has(kind)
        ? e.kind === "dropFiles"
          ? { x: e.to.x, y: e.to.y, in: "before" as const }
          : { x: e.x, y: e.y, in: "before" as const }
        : undefined;
    return {
      id: it.id,
      dir: join(statesDir, it.id),
      ...(it.fidelity ? { fidelity: it.fidelity } : {}),
      ...(e
        ? {
            action: {
              kind,
              ...(e.sel ? { label: e.sel } : {}),
              ...(e.target ? { target: e.target } : {}),
              ...(point ? { point } : {}),
            },
          }
        : {}),
    };
  });
  const srcRatio = log.video?.width && log.viewport?.w ? log.video.width / log.viewport.w : 0;
  return {
    kind: "take",
    root: dir,
    log: join(dir, "capture.json"),
    ...(srcRatio > 0 ? { srcRatio } : {}),
    states,
  };
}

// --- arithmetic ---------------------------------------------------------------------

export type Stage = { width: number; height: number };
export const FILM_STAGE: Stage = { width: 1920, height: 1080 };
/** the share of the stage a part's fit may take, each way */
const FIT_W = 0.7;
const FIT_H = 0.6;

const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;

/** The largest box of the part's shape (its ink or box, ± lift.pad) within
 *  70 % × 60 % of the stage, centred. */
export function fitOf(
  part: Pick<PartCandidate, "box" | "ink" | "lift">,
  stage: Stage = FILM_STAGE,
): ComponentEntry["fit"] {
  const by = part.lift.box === "ink" && part.ink ? "ink" : "box";
  const b = by === "ink" ? part.ink! : part.box;
  const w = Math.max(1, b[2] + 2 * part.lift.pad);
  const h = Math.max(1, b[3] + 2 * part.lift.pad);
  const k = Math.min((FIT_W * stage.width) / w, (FIT_H * stage.height) / h);
  const fw = Math.round(w * k);
  const fh = Math.round(h * k);
  return {
    box: [Math.round((stage.width - fw) / 2), Math.round((stage.height - fh) / 2), fw, fh],
    k: r2(k),
    by,
  };
}

/** Its text's px on a phone: the whole screen contained in the stage, and the
 *  part at its fit — the stage shown PHONE_W px wide. */
export function phoneOf(
  fontPx: number,
  fitK: number,
  viewport: { w: number; h: number },
  stage: Stage = FILM_STAGE,
): { asScreen: number; atFit: number } {
  const phone = PHONE_W / stage.width;
  const screenK = Math.min(stage.width / viewport.w, stage.height / viewport.h);
  return { asScreen: r1(fontPx * screenK * phone), atFit: r1(fontPx * fitK * phone) };
}

// --- gather -------------------------------------------------------------------------

type Loaded = {
  src: ComponentSourceState;
  index: StateIndex | null;
  parts: PartsFile | null;
  why?: string;
};

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const textOf = (index: StateIndex, id: string): string =>
  contentOf(index, id).join(" ").replace(/\s+/g, " ").trim();
const contains = (b: Box, x: number, y: number) =>
  x >= b[0] && x <= b[0] + b[2] && y >= b[1] && y <= b[1] + b[3];

/** the smallest interactive element under a point — a <label> counts (a
 *  styled label standing for a hidden checkbox); null when none */
function interactiveAt(index: StateIndex, x: number, y: number): StateElement | null {
  let best: StateElement | null = null;
  for (const e of index.elements)
    if (
      (e.interactive || e.tag === "label") &&
      contains(e.box, x, y) &&
      (!best || e.box[2] * e.box[3] < best.box[2] * best.box[3])
    )
      best = e;
  return best;
}

/** a matched pair is plausibly one element: the same text, or (text typed,
 *  a toggle's word swapped) much the same size — within 30 % each way */
function samePart(A: StateIndex, a: string, B: StateIndex, b: string): boolean {
  if (textOf(A, a) === textOf(B, b)) return true;
  const ba = A.elements.find((x) => x.id === a)?.box;
  const bb = B.elements.find((x) => x.id === b)?.box;
  if (!ba || !bb) return false;
  const near = (x: number, y: number) => Math.abs(x - y) <= 0.3 * Math.max(x, y, 1);
  return near(ba[2], bb[2]) && near(ba[3], bb[3]);
}

function load(src: ComponentSourceState): Loaded {
  const index = readStateIndex(src.dir);
  if (typeof index === "string") return { src, index: null, parts: null, why: index };
  const p = join(src.dir, "parts.json");
  if (!existsSync(p))
    return {
      src,
      index,
      parts: null,
      why: "no parts.json (saved before the component probe — `open-take components` measures it)",
    };
  try {
    const parts = readJson<PartsFile>(p);
    if (parts.version !== 1 || !Array.isArray(parts.parts))
      return { src, index, parts: null, why: "parts.json is not version 1" };
    return { src, index, parts };
  } catch (e) {
    return { src, index, parts: null, why: `unreadable parts.json: ${(e as Error).message}` };
  }
}

// --- values -------------------------------------------------------------------------

const NUMBER_PARTS_RE =
  /(NT\$|US\$|HK\$|[$€£¥₩])?\s?([-−]?\d(?:[\d,]*\d)?(?:\.\d+)?)\s?(%|[kKM](?![A-Za-z])|\+|萬|億|ms(?![A-Za-z])|fps(?![A-Za-z])|×|x(?![A-Za-z])|[぀-ヿ㐀-鿿]{1,3})?/;

/** The first number in a text, as written, with what stands with it: "轉讓省
 *  NT$4,466" → { text: "NT$4,466", value: 4466, unit: "NT$" }; "18.5個月" →
 *  18.5 "個月". Null when it holds no digit. */
export function readNumber(s: string): { text: string; value: number; unit?: string } | null {
  const m = NUMBER_PARTS_RE.exec(s);
  if (!m) return null;
  const value = Number(m[2]!.replace(/,/g, "").replace("−", "-"));
  if (!Number.isFinite(value)) return null;
  const unit = m[1] && m[3] ? `${m[1]} ${m[3]}` : (m[1] ?? m[3]);
  return { text: m[0].trim(), value, ...(unit ? { unit } : {}) };
}

/** a number that is the whole of a text ("1,288", "18.5"), else null */
const wholeNumber = (s: string) => {
  const n = readNumber(s);
  return n && n.text === s.trim() ? n : null;
};

const LOCAL_HOST = /^(localhost|127(\.\d+){3}|\[?::1\]?|0\.0\.0\.0|.*\.local|.*\.localhost)$/i;
/** the URL's host is this machine (or it is a file) */
function isLocal(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "file:" || LOCAL_HOST.test(u.hostname);
  } catch {
    return false;
  }
}

/** what a part holds, field by field — see ComponentEntry.values */
function valuesOf(
  p: PartCandidate,
  byEl: Map<string, PartCandidate>,
  at: (eid: string, selector?: string) => ComponentValue["source"],
): Record<string, ComponentValue> {
  const out: Record<string, ComponentValue> = {};
  const capped = p.text == null && p.label.endsWith("…");
  const val = (
    text: string,
    from: PartCandidate,
    extra: { value?: number; unit?: string } = {},
  ): ComponentValue => ({
    text,
    ...(extra.value != null ? { value: extra.value } : {}),
    ...(extra.unit ? { unit: extra.unit } : {}),
    ...(from.text == null && text.endsWith("…") ? { capped: true as const } : {}),
    source: at(from.el, from.selector),
  });
  const full = p.text ?? p.label;
  const f: PartFields | undefined = p.fields;
  const own = p.kind === "input" || p.kind === "control";
  if (full && !(own && f)) out.text = val(full, p);
  if (p.kind === "number") {
    const n = readNumber(full);
    if (n) out.number = val(n.text, p, n);
  } else if (p.kind === "stat") {
    // its value: the largest number part inside it, else the number in its text
    let num: PartCandidate | undefined;
    for (const q of byEl.values()) {
      if (q.kind !== "number") continue;
      let up = q.inside;
      while (up && up !== p.el) up = byEl.get(up)?.inside;
      if (up === p.el && (!num || q.look.fontPx > num.look.fontPx)) num = q;
    }
    const n = readNumber(num ? (num.text ?? num.label) : full);
    if (n) {
      out.number = val(n.text, num ?? p, n);
      const words = full.replace(n.text, " ").replace(/\s+/g, " ").trim();
      if (words) out.label = val(words, p);
    }
  } else if (own && f) {
    if (f.value != null) {
      const n = wholeNumber(f.value);
      out.value = val(f.value, p, n ?? {});
    }
    if (f.placeholder) out.placeholder = val(f.placeholder, p);
    for (const k of ["min", "max", "step"] as const) {
      const v = f[k];
      if (v != null) out[k] = val(v, p, wholeNumber(v) ?? {});
    }
    if (f.checked != null) out.checked = val(String(f.checked), p, { value: f.checked ? 1 : 0 });
    if (f.options?.length) out.options = val(f.options.join("\n"), p);
  } else if (p.kind === "field") {
    if (full) out.label = val(full, p);
    const input = p.input ? byEl.get(p.input) : undefined;
    const v = input?.fields?.value;
    if (input && v != null) out.value = val(v, input, wholeNumber(v) ?? {});
  }
  if (f?.name) out.name = val(f.name, p);
  if (capped && !Object.keys(out).length) out.text = val(p.label, p);
  return out;
}

/** a part's state as one string: its ARIA / form state and its fill and
 *  text colour — what a tab or a toggle changes besides its text */
const showsOf = (e: ComponentEntry): Record<string, string> => ({
  ...(e.shows ?? {}),
  ...(e.values.checked ? { checked: e.values.checked.text } : {}),
  fill: e.look.fill ?? "none",
  fg: e.look.fg,
});
const showsKey = (e: ComponentEntry): string =>
  Object.entries(showsOf(e))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
function restyledOf(a: ComponentEntry, b: ComponentEntry): string | undefined {
  const A = showsOf(a);
  const B = showsOf(b);
  const keys = [...new Set([...Object.keys(A), ...Object.keys(B)])].sort();
  const diff = keys
    .filter((k) => A[k] !== B[k])
    .map((k) => `${k}${k === "fill" || k === "fg" ? "" : ":"} ${A[k] ?? "–"} → ${B[k] ?? "–"}`);
  return diff.length ? diff.join("; ") : undefined;
}

/** a step's text: its visible text in full, else an input's value */
const stepText = (e: ComponentEntry, index: StateIndex): string =>
  e.values.text?.text ?? e.values.value?.text ?? textOf(index, e.el);
const stepNumber = (e: ComponentEntry) => e.values.number ?? e.values.value;

/**
 * Gather the inventory of `source`'s saved screens from their parts.json.
 * Screens without one are listed with why (`unmeasured`); the runtime's
 * `inventoryComponents` measures them first.
 */
export function gatherComponents(
  source: ComponentSource,
  opts: { stage?: Stage } = {},
): ComponentsFile {
  const stage = opts.stage ?? FILM_STAGE;
  const rel = (abs: string) => relative(source.root, abs).split(sep).join("/") || ".";
  const loaded = source.states.map(load);
  const first = loaded.find((l) => l.index)?.index;
  const viewport = first
    ? { w: first.viewport.w, h: first.viewport.h, dpr: first.viewport.dpr }
    : { w: stage.width, h: stage.height };

  const states: ComponentState[] = [];
  const all: ComponentEntry[] = [];
  const skipped: ComponentsFile["skipped"] = [];
  const byState = new Map<string, ComponentEntry[]>();
  const ms = { measure: 0, pictures: 0 };
  let prev: Loaded | null = null;
  // matchStates once per pair of screens
  const pairCache = new Map<string, Map<string, string>>();
  const pairsOf = (a: string, A: StateIndex, b: string, B: StateIndex) => {
    const key = `${a}\u0000${b}`;
    let m = pairCache.get(key);
    if (!m) {
      m = matchStates(A, B);
      pairCache.set(key, m);
    }
    return m;
  };

  for (const L of loaded) {
    const id = L.src.id;
    const state: ComponentState = {
      id,
      url: rel(join(L.src.dir, "state.html")),
      ...(L.src.fidelity ? { fidelity: L.src.fidelity } : {}),
      components: [],
    };
    if (L.src.shot) state.shot = rel(L.src.shot);
    if (L.index) {
      let capturedAt: string | undefined;
      try {
        capturedAt = statSync(join(L.src.dir, "index.json")).mtime.toISOString();
      } catch {
        /* the index was read a moment ago; no time is no time */
      }
      state.page = {
        url: L.index.url,
        ...(L.index.title ? { title: L.index.title } : {}),
        ...(capturedAt ? { capturedAt } : {}),
        tMs: L.index.tMs,
        ...(isLocal(L.index.url) ? { local: true as const } : {}),
      };
    }
    const fidelity = L.src.fidelity ?? L.index?.fidelity;
    if (fidelity && !state.fidelity) state.fidelity = fidelity;
    states.push(state);
    if (!L.index || !L.parts) {
      state.unmeasured = L.why ?? "not measured";
      if (L.index) prev = { ...L, parts: null };
      continue;
    }
    const index = L.index;
    const P = L.parts;
    ms.measure += P.ms?.measure ?? 0;
    ms.pictures += P.ms?.pictures ?? 0;
    state.medianTextPx = P.medianTextPx;
    const ref = (el: string) => `${id}:${el}`;
    const byEl = new Map(P.parts.map((p) => [p.el, p]));
    const at = (eid: string, selector?: string): ComponentValue["source"] => ({
      state: id,
      eid,
      ...(selector ? { selector } : {}),
      ...(state.shot ? { shot: state.shot } : {}),
    });
    const provenance: ComponentProvenance = {
      state: id,
      ...(state.page?.url ? { url: state.page.url } : {}),
      ...(state.page?.capturedAt ? { capturedAt: state.page.capturedAt } : {}),
      ...(state.page ? { tMs: state.page.tMs } : {}),
      ...(state.page?.local ? { local: true as const } : {}),
    };
    const entries: ComponentEntry[] = P.parts.map((p) => {
      const fit = fitOf(p, stage);
      const e: ComponentEntry = {
        ref: ref(p.el),
        state: id,
        el: p.el,
        kind: p.kind,
        ...(p.sub ? { sub: p.sub } : {}),
        ...(p.primary ? { primary: true as const } : {}),
        label: p.label,
        values: valuesOf(p, byEl, at),
        relations: [],
        provenance,
        selector: p.selector,
        box: p.box,
        ...(p.ink ? { ink: p.ink } : {}),
        ...(p.inside ? { inside: ref(p.inside) } : {}),
        ...(p.parts?.length ? { parts: p.parts.map(ref) } : {}),
        ...(p.members?.length ? { members: p.members.map(ref) } : {}),
        ...(p.axis ? { axis: p.axis } : {}),
        ...(p.field ? { field: ref(p.field) } : {}),
        ...(p.input ? { input: ref(p.input) } : {}),
        ...(p.state ? { shows: p.state } : {}),
        look: p.look,
        facts: { ...p.facts },
        fit,
        ...(p.picture ? { picture: rel(resolve(L.src.dir, p.picture)) } : {}),
        ...(p.noPicture ? { noPicture: p.noPicture } : {}),
        lift: p.lift,
      };
      return e;
    });
    const byRef = new Map(entries.map((e) => [e.ref, e]));
    // relations the page itself states: what holds what, a field's label
    // and its input, aria-controls
    for (const e of entries) {
      const up = e.inside ? byRef.get(e.inside) : undefined;
      if (up) up.relations.push({ kind: "contains", to: e.ref, by: "layout" });
      if (e.kind === "field" && e.input)
        e.relations.push({ kind: "labels", to: e.input, by: "layout" });
      for (const c of byEl.get(e.el)?.controls ?? [])
        e.relations.push({ kind: "controls", to: ref(c), by: "markup" });
      for (const l of byEl.get(e.el)?.labelledBy ?? [])
        byRef.get(ref(l))?.relations.push({ kind: "labels", to: e.ref, by: "markup" });
    }
    // a block's text: the largest of the parts inside it
    const font = new Map(entries.map((e) => [e.ref, e.look.fontPx]));
    for (const e of entries)
      for (let up = e.inside; up; up = byRef.get(up)?.inside)
        if (BLOCK_TEXT.has(byRef.get(up)?.kind as PartKind))
          font.set(up, Math.max(font.get(up) ?? 0, e.look.fontPx));
    for (const e of entries)
      if (e.kind !== "media" && e.kind !== "logo")
        e.phone = phoneOf(font.get(e.ref)!, e.fit.k, P.viewport ?? index.viewport, stage);
    for (const s of P.skipped ?? [])
      skipped.push({
        ref: ref(s.el),
        kind: s.kind,
        why: s.why,
        ...(s.label ? { label: s.label } : {}),
      });

    // --- what the log adds: since the screen before ---------------------------
    const A = prev?.index ?? null;
    const prevBy = new Map((prev ? (byState.get(prev.src.id) ?? []) : []).map((e) => [e.el, e]));
    /** each part's element in the screen before (when it is the same part) */
    const wasOf = new Map<string, string>();
    if (A && prev) {
      state.since = prev.src.id;
      const pairs = pairsOf(prev.src.id, A, id, index);
      const back = new Map([...pairs].map(([a, b]) => [b, a]));
      const kept = index.elements.filter((e) => back.has(e.id)).length;
      if (kept < 0.4 * index.elements.length) state.newPage = true;
      for (const e of entries) {
        let was = back.get(e.el);
        // a control in another control's slot is new, not that one changed
        if (was != null && ACTABLE.has(e.kind) && !samePart(A, was, index, e.el)) was = undefined;
        if (was == null) {
          if (!state.newPage) e.facts.appeared = true;
          continue;
        }
        wasOf.set(e.el, was);
        const before = textOf(A, was);
        const now = textOf(index, e.el);
        if (before !== now) e.facts.changed = `${cut(before, 40)} → ${cut(now, 40)}`;
        else {
          const a = A.elements.find((x) => x.id === was)?.box;
          if (a?.some((v, i) => Math.abs(v - e.box[i]!) > 2)) e.facts.moved = true;
          const pe = prevBy.get(was);
          const r = pe && pe.kind === e.kind ? restyledOf(pe, e) : undefined;
          if (r) e.facts.restyled = r;
        }
      }
    }
    // the element acted on, in this screen
    const act = L.src.action;
    if (act) {
      const action: ComponentAction = {
        kind: act.kind,
        ...(act.label ? { label: act.label } : {}),
      };
      let hit: string | undefined;
      let by: "capture" | "point" | undefined;
      let before: string | undefined;
      if (A && (act.target || act.point?.in === "before")) {
        const t =
          act.target ?? (act.point ? interactiveAt(A, act.point.x, act.point.y)?.id : undefined);
        by = act.target ? "capture" : "point";
        if (t) {
          hit = pairsOf(prev!.src.id, A, id, index).get(t);
          // a pair whose text and size both changed is another element in
          // its place (下一步 matched to the 上一步 that took its slot)
          if (hit && !samePart(A, t, index, hit)) hit = undefined;
          if (!hit) {
            action.actedBefore = `${prev!.src.id}:${t}`;
            action.by = by;
            before = t;
          }
        }
      } else if (act.point?.in === "after") {
        hit = interactiveAt(index, act.point.x, act.point.y)?.id;
        by = "point";
      }
      if (hit) {
        action.acted = ref(hit);
        action.by = by!;
        // the element itself, the field it is the input of, or a control
        // holding it (a span inside the button)
        for (const e of entries)
          if (
            e.el === hit ||
            e.input === ref(hit) ||
            (ACTABLE.has(e.kind) && subtree(index, e.el).some((x) => x.id === hit))
          )
            e.facts.acted = true;
      }
      const holder = (list: ComponentEntry[], I: StateIndex, el: string) =>
        list.find((e) => e.el === el) ??
        list
          .filter(
            (e) =>
              (ACTABLE.has(e.kind) || e.input?.endsWith(`:${el}`)) &&
              subtree(I, e.el).some((x) => x.id === el),
          )
          .sort((a, b) => a.box[2] * a.box[3] - b.box[2] * b.box[3])[0];
      const from = hit
        ? holder(entries, index, hit)
        : before && A
          ? holder(byState.get(prev!.src.id) ?? [], A, before)
          : undefined;
      // what it changed: the parts that changed, restyled or appeared here,
      // apart from the control itself and what sits inside it (a slider's own
      // readout), and apart from a part around it whose text changed only
      // inside the control (the form holding a slider reads its new value) —
      // a part around it that changed elsewhere too (the wizard card a step's
      // button turned) is kept. Listed on the action whether or not the
      // element acted on is a part (a tab drawn as a bare link), and as the
      // part's `changes` relations when it is one.
      if ((hit || before) && A) {
        // the control's own elements, here and in the screen before: the
        // outermost acted part around the element (a field around its
        // slider), else the element itself
        const ownB = new Set<string>();
        const ownA = new Set<string>();
        if (hit) {
          const outer = entries
            .filter((e) => e.facts.acted && subtree(index, e.el).some((x) => x.id === hit))
            .sort((a, b) => b.box[2] * b.box[3] - a.box[2] * a.box[3])[0];
          for (const x of subtree(index, outer?.el ?? hit)) ownB.add(x.id);
          for (const [a, b] of pairsOf(prev!.src.id, A, id, index)) if (ownB.has(b)) ownA.add(a);
        }
        const t =
          before ?? [...pairsOf(prev!.src.id, A, id, index)].find(([, b]) => b === hit)?.[0];
        if (t) for (const x of subtree(A, from && before ? from.el : t)) ownA.add(x.id);
        /** a part's text without the control's own elements */
        const rest = (I: StateIndex, el: string, own: Set<string>): string => {
          const out: string[] = [];
          for (const x of subtree(I, el)) {
            if (own.has(x.id)) continue;
            const l = visibleLabel(x);
            if (l && !out.some((o) => o.includes(l))) out.push(l);
          }
          return out.join(" ").replace(/\s+/g, " ").trim();
        };
        const changes: string[] = [];
        for (const e of entries) {
          if (!(e.facts.changed || e.facts.restyled || e.facts.appeared)) continue;
          if (e === from || ownB.has(e.el)) continue;
          const was = wasOf.get(e.el);
          if (e.facts.changed && was != null && rest(index, e.el, ownB) === rest(A, was, ownA))
            continue;
          changes.push(e.ref);
        }
        if (changes.length) action.changes = changes;
        if (from)
          for (const to of changes) from.relations.push({ kind: "changes", to, by: "seen" });
      }
      state.action = action;
    }
    state.components = entries.map((e) => e.ref);
    byState.set(id, entries);
    all.push(...entries);
    prev = L;
  }

  // --- tracks: the same part, screen after screen --------------------------------
  type Step = ComponentTrack["steps"][number];
  const tracks: ComponentTrack[] = [];
  const measured = loaded.filter((l) => l.index && l.parts);
  const trackOf = new Map<string, ComponentTrack>();
  const steps = new Map<string, Step[]>();
  const stepOf = (e: ComponentEntry, I: StateIndex): Step => {
    const n = stepNumber(e);
    return {
      state: e.state,
      ref: e.ref,
      text: stepText(e, I),
      ...(n?.value != null ? { value: n.value } : {}),
      ...(n?.unit ? { unit: n.unit } : {}),
      shows: showsKey(e),
    };
  };
  for (let i = 1; i < measured.length; i++) {
    const A = measured[i - 1]!;
    const B = measured[i]!;
    const pairs = pairsOf(A.src.id, A.index!, B.src.id, B.index!);
    const back = new Map([...pairs].map(([a, b]) => [b, a]));
    const aBy = new Map((byState.get(A.src.id) ?? []).map((e) => [e.el, e]));
    for (const eb of byState.get(B.src.id) ?? []) {
      const was = back.get(eb.el);
      const ea = was ? aBy.get(was) : undefined;
      if (!ea || ea.kind !== eb.kind) continue;
      // a control whose text and size both changed is another control in its
      // slot, not the same one (a card or a number may grow; a button does not)
      if (ACTABLE.has(eb.kind) && !samePart(A.index!, ea.el, B.index!, eb.el)) continue;
      eb.before = ea.ref;
      let chain = steps.get(ea.ref);
      if (!chain) {
        chain = [stepOf(ea, A.index!)];
        steps.set(ea.ref, chain);
      }
      chain.push(stepOf(eb, B.index!));
      steps.set(eb.ref, chain);
    }
  }
  const differs = (a: Step, b: Step) =>
    a.text !== b.text || a.value !== b.value || a.shows !== b.shows;
  const seen = new Set<unknown>();
  for (const e of all) {
    const chain = steps.get(e.ref);
    if (!chain || seen.has(chain)) continue;
    seen.add(chain);
    const changes = chain.filter((s, i) => i > 0 && differs(chain[i - 1]!, s)).length;
    if (!changes) continue; // the same part, unchanged throughout: a repeat, not a track
    const last = all.find((x) => x.ref === chain.at(-1)!.ref)!;
    // its state where it says more than its colours: a step that changed only
    // its state names it
    const stateful = chain.some((s, i) => i > 0 && s.shows !== chain[i - 1]!.shows);
    const t: ComponentTrack = {
      id: `t${tracks.length + 1}`,
      kind: e.kind,
      label: cut(last.label, 60),
      changes,
      steps: chain.map(({ shows, ...s }) => (stateful ? { ...s, shows } : s)),
    };
    tracks.push(t);
    for (const s of chain) trackOf.set(s.ref, t);
  }
  for (const e of all) {
    const t = trackOf.get(e.ref);
    if (t) e.track = t.id;
  }
  // repeats: the same kind, text and place on an earlier screen
  const firstOf = new Map<string, string>();
  for (const e of all) {
    if (e.track) continue;
    const key = `${e.kind}|${e.label}|${e.box.map((v) => Math.round(v / 8)).join(",")}`;
    const f = firstOf.get(key);
    if (f) e.repeats = f;
    else firstOf.set(key, e.ref);
  }

  const groups = all
    .filter((e) => e.members?.length)
    .map((e) => ({
      ref: e.ref,
      kind: e.kind,
      ...(e.axis ? { axis: e.axis } : {}),
      members: e.members!,
    }));
  return {
    version: 2,
    about: ABOUT,
    order: COMPONENT_ORDER,
    source: {
      kind: source.kind,
      ...(source.log ? { log: rel(source.log) } : {}),
      viewport,
      ...(source.srcRatio ? { srcRatio: source.srcRatio } : {}),
    },
    stage: {
      width: stage.width,
      height: stage.height,
      phoneWidth: PHONE_W,
      phoneScale: Math.round((PHONE_W / stage.width) * 1e4) / 1e4,
    },
    states,
    components: all,
    groups,
    tracks,
    skipped,
    ms,
  };
}

/** Write the inventory as `<root>/components.json`; returns its path. */
export function writeComponents(file: ComponentsFile, root: string): string {
  const path = join(root, "components.json");
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`);
  return path;
}

// --- reading it -------------------------------------------------------------------

/** How many parts, on how many screens; how many of them are distinct (a
 *  track counts once, a repeat not again). */
export function componentCounts(file: ComponentsFile): {
  parts: number;
  distinct: number;
  screens: number;
  measured: number;
  tracks: number;
} {
  const tracked = new Set<string>();
  let distinct = 0;
  for (const e of file.components) {
    if (e.repeats) continue;
    if (e.track) {
      if (tracked.has(e.track)) continue;
      tracked.add(e.track);
    }
    distinct++;
  }
  return {
    parts: file.components.length,
    distinct,
    screens: file.states.length,
    measured: file.states.filter((s) => !s.unmeasured).length,
    tracks: file.tracks.length,
  };
}

const q = (s: string) => JSON.stringify(s);
const posix = (p: string) => p.split(sep).join("/");

/** Where `abs` is as `film render` serves it when run in `servedFrom` (the
 *  working directory, or --root): a URL from that folder ("/shots/…"),
 *  which reads the same from any page under it ("/" is that folder) — or,
 *  outside it, its path on this machine (`inside` false). */
function servedUrl(abs: string, servedFrom: string): { url: string; inside: boolean } {
  const r = relative(resolve(servedFrom), abs);
  if (!r.startsWith("..") && !isAbsolute(r)) return { url: `/${posix(r)}`, inside: true };
  return { url: posix(abs), inside: false };
}

/**
 * A module for the part named by `ref` (a part the film's author picked —
 * this never picks one): it lifts the part out of its saved screen with the
 * kit (screen() hidden + lift() with the inventory's options) and moves it
 * from where it sat to its fit, with one move of its own by kind, on the
 * product's own values — a number counts from the value its track held
 * first to the one it holds (and does not count when no screen before held
 * another: a count from a value the product never showed would be made up),
 * a button is pressed, an input types or runs to its own value, a card or
 * group assembles its parts.
 *
 * The saved screen's URL: with `root` (the folder components.json is in)
 * and `servedFrom` (the folder `film render` serves — the working directory,
 * or --root), a URL from that folder ("/shots/states/calc/state.html"),
 * which reads the same from any page under it; else `screens`, a path from
 * the page to the folder components.json is in.
 */
export function exampleSource(
  file: ComponentsFile,
  ref: string,
  opts: { screens?: string; root?: string; servedFrom?: string } = {},
): string {
  const e = file.components.find((x) => x.ref === ref);
  if (!e)
    throw new Error(
      `components: no part ${ref} — refs are <state>:<element id>, as components.json lists them`,
    );
  const state = file.states.find((s) => s.id === e.state)!;
  let url: string;
  let where = "";
  if (opts.root && opts.servedFrom) {
    const served = servedUrl(resolve(opts.root, state.url), opts.servedFrom);
    url = served.url;
    where = served.inside
      ? `from the folder film render serves when run in ${posix(resolve(opts.servedFrom))} (or --root that folder)`
      : "the screen's path on this machine — it is outside the folder this was printed in, and film render serves one folder: render with --root on one that holds the page and this screen, and write the URL from there";
  } else {
    const base = (opts.screens ?? ".").replace(/\/+$/, "");
    url = base === "." ? state.url : `${base}/${state.url}`;
    where = "from the page";
  }
  const vp = file.source.viewport;
  const [fx, fy, fw, fh] = e.fit.box;
  const said = [
    e.facts.changed ? `changed since ${state.since}: ${e.facts.changed}` : "",
    e.facts.restyled ? `restyled since ${state.since}: ${e.facts.restyled}` : "",
    e.facts.appeared ? `appeared since ${state.since}` : "",
    e.facts.acted ? "the action acted on it" : "",
  ].filter(Boolean);
  const track = e.track ? file.tracks.find((t) => t.id === e.track) : undefined;
  const liftOpts: string[] = [
    `around: ${q(e.lift.around)}`,
    `box: ${q(e.lift.box === "ink" ? "ink" : "layout")}`,
    `pad: ${e.lift.pad}`,
  ];
  const motion = new Set(["morphRect"]);
  const before: string[] = [];
  const inner: string[] = [];
  /** the number its track's first step held, as that step's part wrote it
   *  (a stat's own number, not the first digits in its text) — null when
   *  that step held none or the same number as `now` */
  const firstOther = (tr: ComponentTrack | undefined, now: number) => {
    const s0 = tr?.steps[0];
    if (!s0 || s0.value == null || s0.value === now) return null;
    const p0 = file.components.find((x) => x.ref === s0.ref);
    const n0 = p0 ? (p0.values.number ?? p0.values.value) : undefined;
    return n0?.value === s0.value ? n0.text : null;
  };
  const num = e.values.number;
  if ((e.kind === "number" || e.kind === "stat") && num?.value != null) {
    const from = firstOther(track, num.value);
    // a stat's number is an element inside it: the text set is that one's
    const into = num.source.eid !== e.el ? `, ${q(num.source.eid)}` : "";
    if (from) {
      motion.add("count");
      inner.push(
        `    part.text(count(t, at + 0.2, ${q(from)}, ${q(num.text)}).text${into}); // from its first step (${track!.id}: ${track!.steps[0]!.state}) to ${num.source.state}, in the product's own format`,
      );
    } else
      inner.push(
        `    // ${q(num.text)} as the product showed it: no screen before held another value of it to count from`,
      );
  } else if (e.kind === "button") {
    motion.add("press");
    before.push("  const pressAt = at + 1.0;");
    inner.push(
      "    const p = press(t, pressAt);",
      "    const r = morphRect(t, at, at + 0.8, part.rect, fit);",
      "    part.place({ x: r.x + (r.w * (1 - p.scale)) / 2, y: r.y + (r.h * (1 - p.scale)) / 2 + p.y, w: r.w * p.scale, h: r.h * p.scale, r: r.r });",
    );
  } else if (e.kind === "input" || e.kind === "field") {
    // its own value: the input's (a field's label is the words around it)
    const input =
      e.kind === "field" ? file.components.find((x) => x.ref === e.input) : (e as ComponentEntry);
    const inputEl = input?.el ?? (e.kind === "field" ? e.input?.split(":")[1] : e.el);
    const value = e.values.value ?? input?.values.value;
    const ownId = input?.track ?? e.track;
    const own = ownId ? file.tracks.find((t) => t.id === ownId) : undefined;
    if (inputEl && value?.text) {
      before.push(
        `  const field = part.find(${q(inputEl)}); // the input itself, in the lifted copy`,
      );
      if (value.value != null && wholeNumber(value.text)) {
        // a number (a slider, a quantity): it runs to its value rather than being typed
        const from = firstOther(own, value.value);
        if (from) {
          motion.add("count");
          inner.push(
            `    const v = count(t, at + 0.9, ${q(from)}, ${q(value.text)}).value; // from its first step (${own!.id})`,
            `    if ("value" in field) field.value = String(v); else field.textContent = String(v);`,
          );
        } else
          inner.push(
            `    // ${q(value.text)} as the product showed it: no screen before held another value of it to run from`,
          );
      } else {
        motion.add("type");
        inner.push(
          `    const typed = type(t, at + 0.9, ${q(value.text)}).text; // its own value`,
          `    if ("value" in field) field.value = typed; else field.textContent = typed;`,
        );
      }
    }
  } else if ((e.kind === "card" || e.kind === "group") && (e.members ?? e.parts)?.length) {
    motion.add("assemble");
    const kids = (e.members ?? e.parts)!.map((r) => q(r.split(":")[1]!));
    liftOpts.push(`parts: [${kids.join(", ")}]`);
    inner.push("    assemble(t, at + 0.5, part.parts()); // its parts arrive one after another");
  }
  const place =
    e.kind === "button" ? [] : ["    part.place(morphRect(t, at, at + 0.8, part.rect, fit));"];
  const phone = e.phone
    ? ` — its text reads ~${Math.round(e.phone.atFit)} px on a phone there (${e.phone.asScreen} px as part of the whole screen)`
    : "";
  const lines = [
    `// ${e.ref} · ${e.kind}${e.sub ? `/${e.sub}` : ""} · ${q(cut(e.label, 50))}${said.length ? ` (${said.join("; ")})` : ""}`,
    "// The part you named, lifted out of its saved screen and moved from where it",
    "// sat to a size where it reads — the wiring, on the product's own values.",
    "// Where it goes, when and how it moves are placeholders:",
    `//   import { liftPart } from "./<this file>.js";`,
    "//   const p = await liftPart(stage, tl);  // stage: a positioned element the film's size",
    "//   p(t);                                 // in window.__render(t)",
    `import { lift, screen } from "./kit/media.js";`,
    `import { ${[...motion].sort().join(", ")} } from "./kit/motion.js";`,
    "",
    "export async function liftPart(stage, tl) {",
    "  // the saved screen it comes from: laid out (lift measures it) but not shown",
    `  const frame = document.createElement("iframe");`,
    `  Object.assign(frame.style, { position: "absolute", left: "0px", top: "0px", width: "${vp.w}px", height: "${vp.h}px", border: "0" });`,
    "  stage.appendChild(frame);",
    `  // this URL: ${where}`,
    `  const src = screen(frame, ${q(url)}, { hidden: true });`,
    `  const part = lift(src, ${q(e.el)}, { ${liftOpts.join(", ")} });`,
    "  await part.ready;",
    "  const at = 0.3; // s",
    `  tl.event(at, "lift", { label: ${q(e.ref)} });`,
    `  // the largest box of its shape within 70 % × 60 % of the stage, centred${phone}`,
    `  const fit = { x: ${fx}, y: ${fy}, w: ${fw}, h: ${fh} };`,
    ...before,
    "  return (t) => {",
    ...place,
    ...inner,
    "  };",
    "}",
    "",
  ];
  return lines.join("\n");
}

// --- the terminal -------------------------------------------------------------------

/** How many of a screen's changed, restyled or appeared parts its summary
 *  names (the rest are in the file). */
export const SUMMARY_PER_SCREEN = 12;

function entryLine(e: ComponentEntry): string {
  const said = [
    e.facts.acted ? "acted on" : "",
    e.facts.changed ? `changed ${e.facts.changed}` : "",
    e.facts.restyled ? `restyled ${e.facts.restyled}` : "",
    e.facts.appeared ? "appeared" : "",
    e.track ? `track ${e.track}` : "",
  ].filter(Boolean);
  return `  ${e.ref.padEnd(16)} ${`${e.kind}${e.sub ? `/${e.sub}` : ""}`.padEnd(12)} ${q(cut(e.label, 44))}${said.length ? ` · ${said.join(" · ")}` : ""}`;
}

/** a count of each kind on a screen, in a fixed order: "3 number · 2 stat …" */
function kindsLine(list: ComponentEntry[]): string {
  const n = new Map<string, number>();
  for (const e of list) n.set(e.kind, (n.get(e.kind) ?? 0) + 1);
  return [...n.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, c]) => `${c} ${k}`)
    .join(" · ");
}

/** The summary `open-take components` prints — information only: per screen,
 *  how many parts of each kind, what the action before it acted on, and
 *  what changed, restyled or appeared since the screen before (in the
 *  page's order); then where the rest is. */
export function formatComponents(
  file: ComponentsFile,
  opts: {
    path: string;
    state?: string;
    dir?: string;
    /** the folder components.json is in, and the one film render serves
     *  (the working directory): with them, the followed tracks and the
     *  product() line */
    at?: string;
    servedFrom?: string;
  } = { path: "components.json" },
): string {
  const c = componentCounts(file);
  const byRef = new Map(file.components.map((e) => [e.ref, e]));
  const relations = file.components.reduce((s, e) => s + e.relations.length, 0);
  const out = [
    `components: ${c.parts} part${c.parts === 1 ? "" : "s"} in ${c.measured} saved screen${c.measured === 1 ? "" : "s"} (${c.distinct} distinct, ${c.tracks} track${c.tracks === 1 ? "" : "s"}, ${relations} relation${relations === 1 ? "" : "s"}) → ${opts.path}`,
    "each part: its values in full with where each was read, its relations, the page it was on (components.json)",
  ];
  for (const s of file.states) {
    if (opts.state && s.id !== opts.state) continue;
    const head = [
      s.action
        ? `after ${s.action.kind}${s.action.label ? ` ${q(cut(s.action.label, 30))}` : ""}`
        : "",
      s.page?.local ? `local page ${s.page.url}` : "",
      s.fidelity && !s.fidelity.ok ? "FIDELITY FAILED (its parts may not look as shot)" : "",
      s.newPage ? "a new page" : "",
    ].filter(Boolean);
    out.push("", `${s.id}${head.length ? ` — ${head.join(" · ")}` : ""}`);
    if (s.unmeasured) {
      out.push(`  not measured: ${s.unmeasured}`);
      continue;
    }
    const list = s.components.map((r) => byRef.get(r)!);
    if (!list.length) {
      out.push("  no parts found (components.json `skipped` says why for each candidate)");
      continue;
    }
    out.push(`  ${kindsLine(list)}`);
    const said = list.filter(
      (e) => e.facts.acted || e.facts.changed || e.facts.restyled || e.facts.appeared,
    );
    for (const e of said.slice(0, SUMMARY_PER_SCREEN)) out.push(entryLine(e));
    const more = said.length - SUMMARY_PER_SCREEN;
    if (more > 0) out.push(`  … ${more} more changed in components.json`);
  }
  out.push("");
  const followed = opts.at ? followedLine(file, opts.at) : null;
  if (followed) out.push(followed);
  if (opts.at && opts.servedFrom) out.push(partsLine(opts.at, opts.servedFrom));
  out.push(
    `skipped: ${file.skipped.length} candidate${file.skipped.length === 1 ? "" : "s"}, each with its reason, in components.json`,
    `snippet: open-take components ${opts.dir ?? "<dir>"} --snippet <ref>   the wiring that lifts a part you name and moves it`,
  );
  return out.join("\n");
}

/** How many followed tracks a summary names (the rest are in the file). */
export const FOLLOWED_SHOWN = 4;

/** The tracks whose every step is a shoot still that kept the cursor
 *  (shots.json) — a part followed through the screens with the mouse where
 *  it was at each one — in the page's order: "followed: t1 input
 *  "<label>" <a> → <b> over <first>…<last>, cursor kept at each step · …". Null when
 *  there is none (a take's or a folder of screens' tracks have no stills).
 *  `dir`: the folder components.json is in. Information only. */
export function followedLine(file: ComponentsFile, dir: string): string | null {
  if (file.source.kind !== "shoot" || !file.source.log) return null;
  let log: ShotsLog;
  try {
    log = readJson<ShotsLog>(resolve(dir, file.source.log));
  } catch {
    return null;
  }
  // the states a still kept the cursor at
  const byFile = new Map((log.states?.items ?? []).map((it) => [it.still, it.id]));
  const cursorAt = new Set<string>();
  for (const s of log.stills ?? []) {
    const id = s.state ?? byFile.get(s.file);
    if (id && s.cursor) cursorAt.add(id);
  }
  const order = new Map(file.components.map((e, i) => [e.ref, i]));
  const followed = file.tracks
    .filter((t) => t.steps.length > 1 && t.steps.every((s) => cursorAt.has(s.state)))
    .sort((a, b) => (order.get(a.steps[0]!.ref) ?? 0) - (order.get(b.steps[0]!.ref) ?? 0));
  if (!followed.length) return null;
  const reads = (s: ComponentTrack["steps"][number]) =>
    s.value != null ? `${s.value}${s.unit ?? ""}` : q(cut(s.text, 20));
  const items = followed.slice(0, FOLLOWED_SHOWN).map((t) => {
    const a = t.steps[0]!;
    const b = t.steps[t.steps.length - 1]!;
    return `${t.id} ${t.kind} ${q(cut(t.label, 30))} ${reads(a)} → ${reads(b)} over ${a.state}…${b.state}, cursor kept at each step`;
  });
  const more = followed.length - FOLLOWED_SHOWN;
  if (more > 0) items.push(`… ${more} more in components.json`);
  return `followed: ${items.join(" · ")}`;
}

/** The line that names the kit's way to use an inventory's parts:
 *  product() on `dir` (the folder components.json is in) at the URL film
 *  render serves it from when run in `servedFrom`. */
export function partsLine(dir: string, servedFrom: string): string {
  const served = servedUrl(resolve(dir), servedFrom);
  const url = served.url.endsWith("/") ? served.url : `${served.url}/`;
  return (
    `parts: product(${q(url)}) in kit/media.js — each part by ref or track as one reference for cam.frame, cursor click/drag, lift, overlays; follows it through the screens and the camera` +
    (served.inside
      ? ""
      : " (its path on this machine: film render serves one folder — --root one that holds the page and this)")
  );
}

/** The one line a shoot or a take prints about its inventory. */
export function componentsLine(
  file: ComponentsFile,
  path: string,
  dir: string,
  measuredS?: number,
): string {
  const c = componentCounts(file);
  if (!c.measured)
    return `components: none measured — ${file.states[0]?.unmeasured ?? "no saved screens"}`;
  const secs = measuredS ?? (file.ms.measure + file.ms.pictures) / 1000;
  return (
    `components: ${c.parts} part${c.parts === 1 ? "" : "s"} in ${c.measured} saved screen${c.measured === 1 ? "" : "s"} (${c.distinct} distinct) → ${path}, measured in ${secs.toFixed(1)} s` +
    ` (open-take components ${dir}); --no-components skips it`
  );
}
