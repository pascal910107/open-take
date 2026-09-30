// A launch film's music anchors: where its downbeats must fall, what energy
// each span carries and which moments hit — read from the film itself, so no
// one types a tempo, a bar count or a second.
//
// The story metadata says what each span is FOR (context, promise, proof,
// payoff, action); a scene change is a structural landing even without a
// story. Mapping, measured on a reference launch film and kept deliberately
// small:
//   - the intro is ambient; the first landing after it hits BIG (the product
//     arrives); the payoff hits BIG; the final call to action hits BIG;
//   - every other chapter landing is a small hit;
//   - a proof span is a groove (the arranger thins it where the interface is
//     busy), the span after the payoff runs at full energy.

import type { EventSheet as FoleyEventSheet, MusicAnchor } from "open-foley";
import { launchSceneWindows } from "./launch-evaluate";
import type { LaunchComposition, LaunchStoryRole } from "./launch-types";

type Candidate = MusicAnchor & { priority: number };

const ROLE: Record<LaunchStoryRole, { energy: MusicAnchor["energy"]; priority: number }> = {
  context: { energy: 0, priority: 1 },
  promise: { energy: 1, priority: 2 },
  proof: { energy: 2, priority: 3 },
  action: { energy: 2, priority: 4 },
  payoff: { energy: 3, priority: 5 },
};

/** Candidates within this window of a cluster's first moment collapse into
 *  one anchor. It sits above the tempo solver's shortest span (four eighths
 *  at the fastest allowed tempo, ≈0.9 s at 120 bpm), so two hits the solver
 *  could not keep apart never reach it. */
const MERGE_S = 1.2;

export type LaunchMusicInput = {
  anchors: MusicAnchor[];
  /** busy foley moments (clicks, keys) for the arranger's thinning */
  busy: number[];
  durationS: number;
};

export function launchMusicAnchors(
  comp: LaunchComposition,
  events: FoleyEventSheet,
): LaunchMusicInput {
  const windows = launchSceneWindows(comp);
  const durationS = windows.at(-1)?.endS ?? events.durationS;
  const cands: Candidate[] = [];
  const beats = comp.story?.beats ?? [];
  for (const beat of beats) {
    const win = windows.find((w) => w.scene.id === beat.sceneId);
    if (!win) continue;
    const r = ROLE[beat.role];
    cands.push({
      atS: win.startS + (beat.startS ?? 0),
      energy: r.energy,
      priority: r.priority,
      label: `${beat.role}: ${beat.id}`,
      ...(beat.role === "payoff" ? { hit: "big" as const } : {}),
    });
  }
  // scene changes land even when no story names them
  windows.forEach((w, i) => {
    if (i === 0) return;
    cands.push({ atS: w.startS, energy: 2, priority: 0, label: `scene: ${w.scene.id}` });
    if (w.scene.type === "end-card")
      cands.push({ atS: w.startS, energy: 2, priority: 4, label: `end card: ${w.scene.id}` });
  });
  if (!cands.some((c) => c.atS < 1)) cands.push({ atS: 0, energy: 0, priority: 1, label: "start" });

  // merge near-coincident candidates into clusters anchored at their first
  // moment (no sliding: a run of beats cannot drag a downbeat along). The
  // strongest role supplies energy, label and hit. Where the downbeat goes:
  // a payoff's own moment (the reveal the film is built around), else a scene
  // cut in the cluster (a hard visual event beats a span marker a moment
  // later), else the strongest candidate's time.
  cands.sort((a, b) => a.atS - b.atS || b.priority - a.priority);
  const merged: Candidate[] = [];
  let start = Number.NEGATIVE_INFINITY;
  let cluster: Candidate[] = [];
  const close = () => {
    if (!cluster.length) return;
    const best = cluster.reduce((m, c) => (c.priority > m.priority ? c : m));
    const cut = cluster.find((c) => c.label?.startsWith("scene: "));
    const payoff = cluster.find((c) => c.priority === ROLE.payoff.priority);
    const opening = cluster[0]!.atS < 1;
    merged.push({
      ...best,
      atS: opening ? cluster[0]!.atS : (payoff?.atS ?? cut?.atS ?? best.atS),
      // the film's opening span takes the calmest energy offered for it —
      // unless the film OPENS on its payoff
      energy:
        opening && !payoff
          ? (Math.min(...cluster.map((c) => c.energy)) as MusicAnchor["energy"])
          : best.energy,
    });
    cluster = [];
  };
  for (const c of cands) {
    if (c.atS - start >= MERGE_S) {
      close();
      start = c.atS;
    }
    cluster.push(c);
  }
  close();
  if (merged.length === 1) merged.push({ atS: durationS * 0.5, energy: 2, priority: 0 });

  // hits: first landing after an ambient intro, the payoff (already big), the
  // final call to action; everything else lands small
  const out: MusicAnchor[] = merged.map((m, i) => {
    const a: MusicAnchor = { atS: m.atS, energy: m.energy, ...(m.label ? { label: m.label } : {}) };
    // the opening downbeat hits only when it IS the payoff
    if (i === 0) return m.hit === "big" ? { ...a, hit: "big" } : a;
    const firstLanding = i === 1 && merged[0]!.energy === 0 && m.atS >= 3;
    const final = i === merged.length - 1;
    a.hit = m.hit === "big" || firstLanding || final ? "big" : "small";
    // a landing never lands into an ambient span
    if (a.energy === 0) a.energy = 1;
    return a;
  });
  const busy = events.events
    .filter((e) => e.kind === "key" || e.kind === "click")
    .map((e) => e.atS);
  return { anchors: out, busy, durationS };
}
