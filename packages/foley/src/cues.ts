// The two documents open-foley speaks.
//
// An EVENT SHEET is what a client hands in: "at 5.5 s something was revealed",
// "from 2.1 s a thing moved for 0.4 s across a third of the frame". It is the
// vocabulary of a timeline, not of a sound — a client that renders video
// already knows every one of these moments, so nothing here has to be guessed
// from pixels.
//
// A CUE SHEET is what spotting produces: every sound to be played, by role,
// with its time, level, pan and seed. It is the editable artifact — change a
// cue's gain or delete it and re-mix — and it is deterministic: the same event
// sheet, style and seed always spot to the same cues, and the same cues always
// mix to the same samples.

/** What happened on the timeline. The vocabulary is deliberately small; a
 *  client maps its own richer events onto it. */
export type FoleyEventKind =
  /** a pointer click / press on something */
  | "click"
  /** one keystroke */
  | "key"
  /** a small discrete landing (an avatar drops in, a list row appears) */
  | "tap"
  /** an element appears (fade / slide in) */
  | "enter"
  /** an element leaves */
  | "exit"
  /** something travels across the frame for `durationS`; `extent` = how far */
  | "move"
  /** the camera pushes in for `durationS`; `extent` = how much closer (0..1) */
  | "zoom-in"
  /** the camera pulls out for `durationS` */
  | "zoom-out"
  /** the camera pans without changing scale */
  | "pan"
  /** the whole frame changes (a cut, a navigation, a global repaint) */
  | "transition"
  /** the payoff: the thing the build was for lands */
  | "reveal"
  /** attention: something arrived (a notification, the opening) */
  | "notify"
  /** a sustained accumulation window (typing, a pile-up) — tension that
   *  resolves at `atS + durationS` */
  | "build"
  /** something was dropped / released */
  | "drop";

export type FoleyEvent = {
  kind: FoleyEventKind;
  /** seconds on the OUTPUT timeline — where the viewer sees it */
  atS: number;
  /** seconds the event occupies (move / zoom / build); a point event omits it */
  durationS?: number;
  /** 0..1, how big a deal this is; absent ⇒ the kind's default */
  intensity?: number;
  /** 0..1, how much of the frame was involved (distance for a move, area for
   *  an enter/transition); absent ⇒ the kind's default */
  extent?: number;
  /** −1 (left) .. 1 (right), where it happened; absent ⇒ centre */
  pan?: number;
  /** where this event came from, for the cue's `from` (editability) */
  label?: string;
};

export type EventSheet = {
  version: 1;
  /** total seconds of the timeline the events sit on */
  durationS: number;
  events: FoleyEvent[];
};

/** The sounds open-foley knows how to play. Every role has a procedural
 *  voice built in (synth.ts) and can be overridden by files (library.ts). */
export type FoleyRole =
  | "tap"
  | "key"
  | "click"
  | "pop"
  | "whoosh"
  | "air"
  | "riser"
  | "impact"
  | "boom"
  | "chime"
  | "ui"
  | "notify"
  | "tick";

export const FOLEY_ROLES: readonly FoleyRole[] = [
  "tap",
  "key",
  "click",
  "pop",
  "whoosh",
  "air",
  "riser",
  "impact",
  "boom",
  "chime",
  "ui",
  "notify",
  "tick",
];

export type Cue = {
  id: string;
  role: FoleyRole;
  /** seconds on the output timeline where the sound STARTS */
  atS: number;
  /** seconds the sound lasts (the voice is rendered to this length) */
  durationS: number;
  /** peak level, dBFS */
  gainDb: number;
  /** −1..1 */
  pan: number;
  /** semitones from the role's base pitch */
  pitch: number;
  /** per-cue seed: the voice's micro-variation (no two taps identical) */
  seed: number;
  /** the event label this cue was spotted from */
  from?: string;
  /** why it is here (for the human/agent reading the sheet) */
  reason?: string;
};

export type CueSheet = {
  version: 1;
  durationS: number;
  style: string;
  seed: number;
  cues: Cue[];
};

export type SheetIssue = { path: string; message: string };

const KINDS = new Set<string>([
  "click",
  "key",
  "tap",
  "enter",
  "exit",
  "move",
  "zoom-in",
  "zoom-out",
  "pan",
  "transition",
  "reveal",
  "notify",
  "build",
  "drop",
]);

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Structural check of an event sheet read from disk. */
export function validateEventSheet(value: unknown): SheetIssue[] {
  const issues: SheetIssue[] = [];
  const add = (path: string, message: string) => issues.push({ path, message });
  if (!value || typeof value !== "object") return [{ path: "", message: "must be an object" }];
  const v = value as Record<string, unknown>;
  if (v.version !== 1) add("version", "must be 1");
  if (!num(v.durationS) || v.durationS <= 0) add("durationS", "must be a positive number");
  if (!Array.isArray(v.events)) {
    add("events", "must be an array");
    return issues;
  }
  v.events.forEach((raw, i) => {
    const p = `events[${i}]`;
    if (!raw || typeof raw !== "object") {
      add(p, "must be an object");
      return;
    }
    const e = raw as Record<string, unknown>;
    if (typeof e.kind !== "string" || !KINDS.has(e.kind))
      add(`${p}.kind`, `unknown kind ${JSON.stringify(e.kind)}`);
    if (!num(e.atS) || e.atS < 0) add(`${p}.atS`, "must be a number ≥ 0");
    if (e.durationS !== undefined && (!num(e.durationS) || e.durationS < 0))
      add(`${p}.durationS`, "must be a number ≥ 0");
    for (const k of ["intensity", "extent"] as const)
      if (e[k] !== undefined && (!num(e[k]) || (e[k] as number) < 0 || (e[k] as number) > 1))
        add(`${p}.${k}`, "must be within 0..1");
    if (e.pan !== undefined && (!num(e.pan) || e.pan < -1 || e.pan > 1))
      add(`${p}.pan`, "must be within -1..1");
  });
  return issues;
}

/** Structural check of a cue sheet read from disk. */
export function validateCueSheet(value: unknown): SheetIssue[] {
  const issues: SheetIssue[] = [];
  const add = (path: string, message: string) => issues.push({ path, message });
  if (!value || typeof value !== "object") return [{ path: "", message: "must be an object" }];
  const v = value as Record<string, unknown>;
  if (v.version !== 1) add("version", "must be 1");
  if (!num(v.durationS) || v.durationS <= 0) add("durationS", "must be a positive number");
  if (!Array.isArray(v.cues)) {
    add("cues", "must be an array");
    return issues;
  }
  const ids = new Set<string>();
  v.cues.forEach((raw, i) => {
    const p = `cues[${i}]`;
    if (!raw || typeof raw !== "object") {
      add(p, "must be an object");
      return;
    }
    const c = raw as Record<string, unknown>;
    if (typeof c.id !== "string" || !c.id) add(`${p}.id`, "must be a non-empty string");
    else if (ids.has(c.id)) add(`${p}.id`, "duplicate cue id");
    else ids.add(c.id);
    if (typeof c.role !== "string" || !(FOLEY_ROLES as readonly string[]).includes(c.role))
      add(`${p}.role`, `unknown role ${JSON.stringify(c.role)}`);
    if (!num(c.atS)) add(`${p}.atS`, "must be a number");
    if (!num(c.durationS) || c.durationS <= 0) add(`${p}.durationS`, "must be a positive number");
    if (!num(c.gainDb) || c.gainDb > 0) add(`${p}.gainDb`, "must be a number ≤ 0 (dBFS)");
    if (!num(c.pan) || c.pan < -1 || c.pan > 1) add(`${p}.pan`, "must be within -1..1");
    if (!num(c.pitch)) add(`${p}.pitch`, "must be a number (semitones)");
    if (!num(c.seed)) add(`${p}.seed`, "must be a number");
  });
  return issues;
}

export function formatSheetIssues(issues: SheetIssue[]): string {
  return issues.map((x) => `  ${x.path || "<root>"}: ${x.message}`).join("\n");
}
