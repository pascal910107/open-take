// Spotting: the event sheet goes in, the cue sheet comes out.
//
// This is the step a sound designer does in a "spotting session" — walk the
// timeline, decide what gets a sound. Here it is a table: each event kind
// maps to one or more roles with a placement rule (a whoosh departs a little
// before the move so its peak rides the motion; a payoff is a stack at the
// landing frame; a riser fills a build and stops where the hit begins). Then
// two density passes keep it from turning to mush: same-role cues that
// collide collapse into the louder one, and micro cues are capped per second.
//
// Pure: same (sheet, style, seed) → same cues.

import type { Cue, CueSheet, EventSheet, FoleyEvent, FoleyRole } from "./cues";
import { resolveStyle, type Style } from "./style";
import { rng } from "./synth";

export type SpotOpts = {
  style?: string | Style;
  seed?: number;
};

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Cue lengths that are not tied to an event's own duration. */
const FIXED_DURATION_S: Partial<Record<FoleyRole, number>> = {
  tap: 0.09,
  key: 0.11,
  click: 0.12,
  pop: 0.16,
  impact: 0.7,
  boom: 3.2,
  chime: 2.4,
  ui: 0.16,
  notify: 0.5,
  tick: 0.03,
};

const MICRO: ReadonlySet<FoleyRole> = new Set(["tap", "key", "click", "tick"]);

type Draft = Omit<Cue, "id" | "seed" | "pitch"> & { order: number };

function hashSeed(base: number, i: number, role: string): number {
  let h = (base ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (i + 1), 0x85ebca6b) >>> 0;
  for (let k = 0; k < role.length; k++) h = Math.imul(h ^ role.charCodeAt(k), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

export function spot(sheet: EventSheet, opts: SpotOpts = {}): CueSheet {
  const style = resolveStyle(opts.style);
  const seed = opts.seed ?? 1;
  const drafts: Draft[] = [];
  const events = [...sheet.events].sort((a, b) => a.atS - b.atS);

  const level = (role: FoleyRole, intensity: number) =>
    style.levelDb[role] + (clamp(intensity, 0, 1) - 0.5) * style.intensitySwingDb;

  const put = (
    role: FoleyRole,
    atS: number,
    e: FoleyEvent,
    order: number,
    reason: string,
    over: Partial<Pick<Draft, "durationS" | "gainDb">> = {},
  ) => {
    const intensity = e.intensity ?? 0.5;
    drafts.push({
      role,
      atS: Math.max(0, atS),
      durationS: over.durationS ?? FIXED_DURATION_S[role] ?? 0.4,
      gainDb: over.gainDb ?? level(role, intensity),
      pan: clamp((e.pan ?? 0) * style.panWidth, -1, 1),
      from: e.label,
      reason,
      order,
    });
  };

  // A whoosh's peak sits ~42% in (synth.ts). Start it a touch before the move
  // so the swell is already audible when the motion begins.
  const swell = (role: FoleyRole, e: FoleyEvent, order: number, reason: string, pre = 0.04) => {
    const d = clamp((e.durationS ?? 0.4) * 1.1, 0.25, 1.0);
    put(role, e.atS - pre, e, order, reason, { durationS: d });
  };

  events.forEach((e, i) => {
    const ext = e.extent ?? 0.5;
    switch (e.kind) {
      case "click":
        if (style.clicks) put("click", e.atS, e, i, "click");
        break;
      case "key":
        if (style.keys) put("key", e.atS, e, i, "keystroke");
        break;
      case "tap":
        put("tap", e.atS, e, i, "landing");
        break;
      case "enter":
        if (style.enter !== "none") put(style.enter, e.atS, e, i, "enter");
        break;
      case "exit":
        break;
      case "drop":
        for (const role of style.drop) put(role, e.atS, e, i, "drop");
        break;
      case "move":
        if (ext >= style.moveWhooshExtent)
          swell("whoosh", e, i, `move across ${(ext * 100).toFixed(0)}% of the frame`);
        break;
      case "zoom-in":
        if (style.camera) swell("whoosh", e, i, "camera pushes in");
        break;
      case "zoom-out":
        if (style.camera) swell("air", e, i, "camera pulls out");
        break;
      case "pan":
        if (style.camera && ext >= style.moveWhooshExtent) swell("air", e, i, "camera pans");
        break;
      case "transition":
        // an air whoosh peaks ~50% in: start it so the peak lands just after the cut
        for (const role of style.transition)
          if (role === "air" || role === "whoosh")
            put(role, e.atS - 0.16, e, i, "transition", { durationS: 0.45 });
          else put(role, e.atS, e, i, "transition");
        break;
      case "reveal":
        // the payoff stack: everything on the landing frame, the tail a hair late
        for (const role of style.reveal)
          put(role, e.atS + (role === "chime" ? 0.05 : role === "boom" ? 0.01 : 0), e, i, "payoff");
        break;
      case "notify":
        put("notify", e.atS, e, i, "notification");
        break;
      case "build":
        if (style.riser && (e.durationS ?? 0) >= 0.4)
          put("riser", e.atS, e, i, "build", { durationS: e.durationS });
        break;
    }
  });

  // --- density -----------------------------------------------------------
  drafts.sort((a, b) => a.atS - b.atS || a.order - b.order);

  // same-role collisions collapse into the louder cue
  const kept: Draft[] = [];
  const lastByRole = new Map<FoleyRole, number>();
  for (const d of drafts) {
    const gap = style.minGapS[d.role] ?? 0;
    const prevIdx = lastByRole.get(d.role);
    const prev = prevIdx === undefined ? undefined : kept[prevIdx];
    if (prev && d.atS - prev.atS < gap) {
      if (d.gainDb > prev.gainDb) kept[prevIdx!] = { ...d, atS: prev.atS };
      continue;
    }
    lastByRole.set(d.role, kept.length);
    kept.push(d);
  }

  // micro cap: within any 1 s window keep only the loudest N micro cues
  const micro = kept.filter((d) => MICRO.has(d.role));
  const dropped = new Set<Draft>();
  for (let i = 0; i < micro.length; i++) {
    const window = micro.filter((d, j) => j <= i && !dropped.has(d) && micro[i]!.atS - d.atS <= 1);
    if (window.length > style.maxMicroPerSecond) {
      const quietest = window.reduce((m, d) => (d.gainDb < m.gainDb ? d : m));
      dropped.add(quietest);
    }
  }

  const final = kept.filter((d) => !dropped.has(d));
  const counter = new Map<FoleyRole, number>();
  const cues: Cue[] = final.map((d, i) => {
    const n = (counter.get(d.role) ?? 0) + 1;
    counter.set(d.role, n);
    const cueSeed = hashSeed(seed, i, d.role);
    const r = rng(cueSeed);
    const jitter = style.pitchJitter[d.role] ?? 0;
    const { order: _order, ...rest } = d;
    return {
      id: `${d.role}-${n}`,
      ...rest,
      atS: Math.round(d.atS * 1000) / 1000,
      gainDb: Math.round((d.gainDb + (r() - 0.5) * 2 * style.gainJitterDb) * 10) / 10,
      pitch: Math.round((r() - 0.5) * 2 * jitter * 10) / 10,
      seed: cueSeed,
    };
  });

  return { version: 1, durationS: sheet.durationS, style: style.name, seed, cues };
}
