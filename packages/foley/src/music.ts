// The music layer: a score that follows the picture.
//
// A client hands in ANCHORS — the moments the picture is structured around
// (a chapter lands, the payoff reveals, the call to action) — each with the
// energy the span after it should carry and whether something HITS on it.
// `arrange` solves a tempo map so every anchor is a downbeat (tempo.ts), then
// writes a MUSIC SHEET: sections with tempo, length, energy, the breath before
// a hit and the build into it. `renderMusic` performs the sheet with the
// procedural band (instruments.ts).
//
// What was measured on a reference launch film, and is encoded here rather
// than left to whoever writes the next film:
//   - structure sits on the grid, gestures do not (anchors → downbeats; the
//     clicks inside a scene are foley's, at their own times);
//   - a big hit is prepared: a riser from a beat boundary, a pull-back of the
//     bed for the last beat or two, the impact on the downbeat;
//   - the bed thins where the interface is busy, so foley can speak.
//
// Pure and seeded, like everything in the package.

import {
  addInto,
  dbToLin,
  highShelf,
  oscillate,
  peakEq,
  pingPong,
  reverb,
  SR,
  sidechainCurve,
  svf,
} from "./dsp";
import {
  type BassKind,
  bassNote,
  bellNote,
  clap,
  crash,
  hat,
  type KickShape,
  keysChord,
  kick,
  malletNote,
  type PadKind,
  padChord,
  pitchRise,
  pluck,
  reverseCymbal,
  rim,
  shaker,
  snap,
  snare,
  sweep,
  taiko,
} from "./instruments";
import { rng } from "./synth";
import { solveTempo, type TempoOpts } from "./tempo";
import type { Pcm } from "./wav";

export type Energy = 0 | 1 | 2 | 3;

export type MusicAnchor = {
  /** the downbeat (seconds on the output timeline) */
  atS: number;
  /** energy of the span that starts here: 0 ambient · 1 thin groove · 2 groove · 3 full */
  energy: Energy;
  /** what lands on this downbeat */
  hit?: "small" | "big";
  label?: string;
};

export type MusicSection = {
  atS: number;
  /** length in eighth notes (the last bar may be partial) */
  eighths: number;
  bpm: number;
  energy: Energy;
  hit?: "small" | "big";
  /** eighths at the end with no kick or bass — the breath before the next hit */
  breath: number;
  /** eighths at the end carrying a riser and a roll into the next downbeat */
  build: number;
  label?: string;
};

export type MusicSheet = {
  version: 1;
  style: string;
  seed: number;
  durationS: number;
  key: string;
  /** chord per bar, cycling; a big hit restarts it on the tonic */
  progression: string[];
  sections: MusicSection[];
  /** the final hit; the outro plays from here to the end */
  outro?: { atS: number; bpm: number; hit: "small" | "big"; label?: string };
  /** anchors too close to a neighbour to own a downbeat */
  dropped: number[];
  targetBpm: number;
  /** windows where the interface is busy (typing, clicking): the bed makes
   *  room — no hats or claps, and it sits a few dB lower — so foley speaks */
  clear?: [number, number][];
};

export type ArrangeInput = {
  durationS: number;
  /** in time order; the LAST anchor is the final hit that starts the outro */
  anchors: MusicAnchor[];
  /** times of busy foley (clicks, keys): spans dense with them get a thinner bed */
  busy?: number[];
};

export type ArrangeOpts = TempoOpts & { style?: string; seed?: number };

// --- harmony ---------------------------------------------------------------

type Chord = { root: number; pad: number[]; arp: number[] };

/** A minor: i · VI · III · VII — the four-chord loop of a thousand launch
 *  films, voiced so each change moves the fewest notes. */
const CHORDS: Record<string, Chord> = {
  Am: { root: 33, pad: [57, 60, 64, 69], arp: [69, 72, 76, 81] },
  F: { root: 29, pad: [53, 60, 65, 69], arp: [65, 69, 72, 77] },
  C: { root: 36, pad: [55, 60, 64, 67], arp: [67, 72, 76, 79] },
  G: { root: 31, pad: [55, 59, 62, 67], arp: [67, 71, 74, 79] },
};
const PROGRESSION = ["Am", "F", "C", "G"];

// --- arrange -----------------------------------------------------------------

const HIT_RANK = { big: 2, small: 1 } as const;
const hitRank = (a: MusicAnchor) => (a.hit ? HIT_RANK[a.hit] : 0);

export function arrange(input: ArrangeInput, opts: ArrangeOpts = {}): MusicSheet {
  // anchors inside the film only; then collapse anchors too close to own a
  // downbeat each (the same span floor the tempo solver uses), in clusters
  // anchored at their first moment: the stronger hit keeps the downbeat, the
  // earlier one on a tie — so a payoff a breath before the end card becomes
  // ONE hit, and two anchors at the same time never lose the bigger one.
  // Everything set aside is reported in `dropped`.
  const outside: number[] = [];
  const inside = input.anchors
    .filter((a) => {
      const ok = Number.isFinite(a.atS) && a.atS >= 0 && a.atS < input.durationS;
      if (!ok) outside.push(a.atS);
      return ok;
    })
    .sort((a, b) => a.atS - b.atS || hitRank(b) - hitRank(a));
  const gap = (4 * 30) / ((opts.bpm ?? 120) * (1 + (opts.range ?? 0.12)));
  const anchors: MusicAnchor[] = [];
  const collapsed: number[] = [];
  let clusterStart = Number.NEGATIVE_INFINITY;
  for (const a of inside) {
    const prev = anchors.at(-1);
    if (prev && a.atS - clusterStart < gap) {
      if (hitRank(a) > hitRank(prev)) {
        collapsed.push(prev.atS);
        anchors[anchors.length - 1] = { ...a };
      } else collapsed.push(a.atS);
      continue;
    }
    clusterStart = a.atS;
    anchors.push({ ...a });
  }
  if (!anchors.length)
    return {
      version: 1,
      style: opts.style ?? "pulse",
      seed: opts.seed ?? 1,
      durationS: Math.max(0, input.durationS),
      key: "A minor",
      progression: PROGRESSION,
      sections: [],
      dropped: [...outside, ...collapsed],
      targetBpm: opts.bpm ?? 120,
    };
  const final = anchors[anchors.length - 1]!;
  const body = anchors.slice(0, -1);
  const times = [...body.map((a) => a.atS), final.atS];
  // a big hit and the final hit always keep their downbeat
  const protect = [...anchors.filter((a) => a.hit === "big").map((a) => a.atS), final.atS];
  const map =
    times.length >= 2
      ? solveTempo(times, opts, protect)
      : { spans: [], dropped: [], targetBpm: opts.bpm ?? 120 };
  const byTime = (t: number) => anchors.find((a) => Math.abs(a.atS - t) < 0.002);
  const busy = [...(input.busy ?? [])].sort((a, b) => a - b);
  const sections: MusicSection[] = map.spans.map((span) => {
    const a = byTime(span.atS)!;
    const end = span.atS + (span.eighths * 30) / span.bpm;
    const count = busy.filter((t) => t >= span.atS && t < end).length;
    const dense = count / Math.max(0.5, end - span.atS) > 3;
    const energy = (dense ? Math.min(a.energy, 1) : a.energy) as Energy;
    return {
      atS: span.atS,
      eighths: span.eighths,
      bpm: span.bpm,
      energy,
      ...(a.hit ? { hit: a.hit } : {}),
      breath: 0,
      build: 0,
      ...(a.label ? { label: a.label } : {}),
    };
  });
  // the breath and the build belong to the span BEFORE a hit
  sections.forEach((s, i) => {
    const next = sections[i + 1] ?? { hit: final.hit ?? "small" };
    const odd = s.eighths % 2;
    if (next.hit === "big") {
      s.breath = Math.min(s.eighths - 4, 4 + odd);
      s.build = Math.min(s.eighths - 2, 16);
    } else if (next.hit === "small") {
      // every chapter landing is punctuated: a beat of breath (more if odd)
      s.breath = Math.min(s.eighths - 4, 2 + odd);
    } else s.breath = odd ? Math.min(s.eighths - 4, 3) : 0;
    s.breath = Math.max(0, s.breath);
    s.build = Math.max(0, s.build);
  });
  const lastBpm = sections.at(-1)?.bpm ?? map.targetBpm;
  // busy windows: runs of foley moments closer than 0.35 s, dense enough to
  // be a gesture the viewer is following (≥ 3 per second, ≥ 0.5 s long)
  const clear: [number, number][] = [];
  let run: number[] = [];
  const flush = () => {
    if (run.length >= 3) {
      const a = run[0]!;
      const b = run[run.length - 1]!;
      if (b - a >= 0.5 && run.length / (b - a) >= 3)
        clear.push([+(a - 0.1).toFixed(3), +(b + 0.15).toFixed(3)]);
    }
    run = [];
  };
  for (const t of busy) {
    if (run.length && t - run[run.length - 1]! > 0.35) flush();
    run.push(t);
  }
  flush();
  return {
    version: 1,
    style: opts.style ?? "pulse",
    seed: opts.seed ?? 1,
    durationS: input.durationS,
    key: "A minor",
    progression: PROGRESSION,
    sections,
    outro: {
      atS: final.atS,
      bpm: lastBpm,
      hit: final.hit ?? "small",
      ...(final.label ? { label: final.label } : {}),
    },
    dropped: [...outside, ...collapsed, ...map.dropped].sort((a, b) => a - b),
    targetBpm: map.targetBpm,
    ...(clear.length ? { clear } : {}),
  };
}

// --- perform -----------------------------------------------------------------

/** Levels (dB) of each part before the master. The balance is the taste;
 *  these are the numbers to turn, one at a time, by ear. */
export const PULSE_LEVELS = {
  kick: -4,
  kickHit: -2,
  clap: -12,
  snap: -14,
  rim: -16,
  hat: -14,
  openHat: -15,
  shaker: -21,
  crash: -15,
  reverse: -14,
  sweep: -12,
  roll: -13,
  rise: -16,
  taiko: -5,
  subDrop: -9,
  bass: -9,
  pad: -17,
  keys: -13,
  pluck: -21,
  mallet: -17,
  bell: -17,
  reverbReturn: -9,
};
export type MusicLevels = typeof PULSE_LEVELS;

export type MusicStyle = "pulse" | "cinematic" | "minimal" | "chill";
export type DrumKit = "pulse" | "deep" | "tight" | "soft";
export type BassPart = BassKind | "none";
export type PadPart = PadKind | "keys" | "none";
export type ArpPart = "pulse" | "mallet" | "bell" | "bright" | "none";
export type BuildKind = "pulse" | "cinematic" | "minimal" | "rise";

/** What the band plays. A style sets the groove and a default for every
 *  part; any part can be swapped on its own (that is what an audition
 *  changes, one at a time). */
export type MusicKit = {
  style?: MusicStyle;
  drums?: DrumKit;
  bass?: BassPart;
  pad?: PadPart;
  arp?: ArpPart;
  build?: BuildKind;
};

export const STYLE_KITS: Record<MusicStyle, Required<Omit<MusicKit, "style">>> = {
  /** four on the floor, offbeat hats, a clap on 2 and 4, pumping bass */
  pulse: { drums: "pulse", bass: "pulse", pad: "pulse", arp: "pulse", build: "pulse" },
  /** no kit: big low drums on the bar, an eighth-note bass ostinato, air */
  cinematic: { drums: "deep", bass: "pulse", pad: "airy", arp: "bell", build: "cinematic" },
  /** a soft pulse and a pluck line, room for the interface to speak */
  minimal: { drums: "soft", bass: "sub", pad: "none", arp: "bright", build: "minimal" },
  /** half-time, a rim on 3, swung shaker, electric-piano stabs */
  chill: { drums: "soft", bass: "sub", pad: "keys", arp: "mallet", build: "minimal" },
};

export function resolveKit(kit: MusicKit = {}): Required<MusicKit> {
  const style = kit.style ?? "pulse";
  const out: Required<MusicKit> = { style, ...STYLE_KITS[style] };
  for (const k of ["drums", "bass", "pad", "arp", "build"] as const)
    if (kit[k]) (out as Record<string, string>)[k] = kit[k]!;
  return out;
}

const DRUM_SHAPES: Record<
  DrumKit,
  {
    end: number;
    shape: KickShape;
    back: "clap" | "snap" | "rim";
    hats: "hat" | "shaker";
    sixteenths: boolean;
  }
> = {
  pulse: { end: 48, shape: {}, back: "clap", hats: "hat", sixteenths: true },
  deep: {
    end: 40,
    shape: { tau: 0.26, click: 0.12, drive: 1.2 },
    back: "snap",
    hats: "hat",
    sixteenths: false,
  },
  tight: {
    end: 58,
    shape: { tau: 0.09, click: 0.55, drive: 1.8 },
    back: "clap",
    hats: "hat",
    sixteenths: true,
  },
  soft: {
    end: 50,
    shape: { tau: 0.12, click: 0, drive: 1, lp: 2500 },
    back: "rim",
    hats: "shaker",
    sixteenths: false,
  },
};

type Bus = { L: Float32Array; R: Float32Array };
const bus = (n: number): Bus => ({ L: new Float32Array(n), R: new Float32Array(n) });

function addStereo(
  b: Bus,
  src: [Float32Array, Float32Array] | Float32Array,
  at: number,
  db: number,
  pan = 0,
) {
  const g = dbToLin(db);
  if (src instanceof Float32Array) {
    const th = ((pan + 1) / 2) * (Math.PI / 2);
    addInto(b.L, src, at, g * Math.cos(th) * Math.SQRT2);
    addInto(b.R, src, at, g * Math.sin(th) * Math.SQRT2);
  } else {
    addInto(b.L, src[0], at, g);
    addInto(b.R, src[1], at, g);
  }
}

export type MusicRender = {
  pcm: Pcm;
  /** every kick, for anything that wants to pump with the music */
  kicksS: number[];
  /** downbeats that carry a hit */
  hitsS: { atS: number; hit: "small" | "big" }[];
};

export function renderMusic(
  sheet: MusicSheet,
  levels: MusicLevels = PULSE_LEVELS,
  kitIn: MusicKit = {},
): MusicRender {
  const kit = resolveKit(kitIn);
  const drumsKit = DRUM_SHAPES[kit.drums];
  const n = Math.ceil(sheet.durationS * SR);
  let musicEnd = n;
  const r = rng(sheet.seed * 7919 + 17);
  const seed = () => Math.floor(r() * 2 ** 31);
  const at = (t: number) => Math.round(t * SR);

  const drums = bus(n);
  const fx = bus(n);
  const pads = bus(n);
  const plucks = bus(n);
  const bells = bus(n);
  const bass = new Float32Array(n);
  const kicksS: number[] = [];
  const hitsS: { atS: number; hit: "small" | "big" }[] = [];
  const clear = sheet.clear ?? [];
  const inClear = (t: number) => clear.some(([a, b]) => t >= a && t < b);
  // the bed's level: 1 except in a breath, where everything but the build
  // (riser, roll, reversed cymbal — all on the fx bus) pulls back
  const bed = new Float32Array(n).fill(1);
  const pullBack = (t0: number, t1: number, db: number) => {
    const floor = dbToLin(db);
    const ramp = Math.round(0.06 * SR);
    const a = at(t0);
    const b = at(t1);
    for (let i = Math.max(0, a - ramp); i < Math.min(n, b + ramp); i++) {
      const u = i < a ? (a - i) / ramp : i > b ? (i - b) / ramp : 0;
      bed[i] = Math.min(bed[i]!, floor + (1 - floor) * Math.min(1, u));
    }
  };

  // cutoff automation points for the pad bus: [time, Hz]
  const cutoff: [number, number][] = [];
  const brightness = kit.pad === "airy" ? 1.6 : kit.pad === "warm" ? 0.55 : 1;
  const CUT: Record<Energy, number> = { 0: 900, 1: 2200, 2: 3600, 3: 6000 };
  const cut = (e: Energy) => CUT[e] * brightness;

  let chordIx = 0;
  const chordAt = () => CHORDS[sheet.progression[chordIx % sheet.progression.length]!]!;

  const playKick = (t: number, db: number, long = false) => {
    addStereo(
      drums,
      kick(seed(), long ? Math.min(46, drumsKit.end) : drumsKit.end, long, drumsKit.shape),
      at(t),
      db,
    );
    kicksS.push(t);
  };
  const playHit = (t: number, hit: "small" | "big") => {
    hitsS.push({ atS: t, hit });
    const big = hit === "big";
    if (kit.build === "cinematic" || kit.style === "cinematic") {
      addStereo(drums, taiko(seed(), true), at(t), levels.taiko + (big ? 1 : -2));
      kicksS.push(t);
      if (big) {
        const sub = new Float32Array(Math.round(1.8 * SR));
        oscillate(
          sub,
          0,
          sub.length,
          (i) => 44 - 12 * (i / sub.length),
          "sine",
          (i) => Math.min(1, i / SR / 0.004) * Math.exp(-i / SR / 0.6),
        );
        addStereo(drums, sub, at(t), levels.subDrop);
      }
      addStereo(fx, crash(seed(), big ? 3.2 : 2.4), at(t), levels.crash - 3);
      return;
    }
    playKick(t, levels.kickHit - (kit.build === "minimal" ? 3 : 0), true);
    addStereo(
      fx,
      crash(seed(), big ? 3.2 : 2.4),
      at(t),
      levels.crash + (big ? 2 : 0) - (kit.build === "minimal" ? 4 : 0),
    );
  };

  const backbeat = (t: number, db = 0) => {
    const i = at(t);
    if (drumsKit.back === "clap") addStereo(drums, clap(seed()), i, levels.clap + db);
    else if (drumsKit.back === "snap") addStereo(drums, snap(seed()), i, levels.snap + db);
    else addStereo(drums, rim(seed()), i, levels.rim + db);
  };
  const tick = (t: number, db: number, pan: number, open = false) => {
    if (drumsKit.hats === "shaker")
      addStereo(drums, shaker(seed()), at(t), levels.shaker + 6 + db, pan);
    else addStereo(drums, hat(seed(), open), at(t), (open ? levels.openHat : levels.hat) + db, pan);
  };
  const bassPlay = (t: number, dur: number, midi: number, bright: number) => {
    if (kit.bass === "none") return;
    bassNote(bass, at(t), dur, midi, dbToLin(levels.bass), bright, kit.bass);
  };
  const arpFrom: Record<MusicStyle, Energy> = { pulse: 3, cinematic: 2, minimal: 2, chill: 3 };

  /** One eighth note of the groove, for every part, in this style. */
  const perform = (
    t: number,
    e8: number,
    k: number,
    inBar: number,
    energy: Energy,
    chord: Chord,
    breathFrom: number,
    quiet: boolean,
    /** a hit already sounds on this downbeat */
    taken: boolean,
  ) => {
    const onBeat = inBar % 2 === 0;
    if (energy === 0) {
      // the ambient intro breathes in half-bar pulses that swell into what follows
      if (inBar % 4 === 0) {
        const u = k / Math.max(1, breathFrom);
        if (kit.style === "cinematic")
          addStereo(drums, taiko(seed()), at(t), levels.taiko - 14 + 10 * u);
        else addStereo(drums, kick(seed(), 46), at(t), levels.kick - 16 + 12 * u);
      }
      return;
    }
    switch (kit.style) {
      case "pulse": {
        if (onBeat && !taken) playKick(t, levels.kick);
        if (!quiet) {
          if (!onBeat) tick(t, 0, 0.25, energy >= 3);
          else if (energy >= 2) tick(t, -8, -0.25);
          if (energy >= 2 && drumsKit.sixteenths)
            tick(t + e8 / 2, levels.shaker - levels.hat, onBeat ? 0.4 : -0.4);
          if (energy >= 2 && (inBar === 2 || inBar === 6)) backbeat(t);
        }
        if (energy === 1 && inBar === 0)
          bassPlay(t, Math.min(8, breathFrom - k) * e8 * 0.98, chord.root, 0.6);
        else if (energy === 2 && (!onBeat || inBar === 0)) bassPlay(t, e8 * 0.8, chord.root, 0.9);
        else if (energy === 3) bassPlay(t, e8 * 0.85, chord.root + (onBeat ? 0 : 12), 1.1);
        break;
      }
      case "cinematic": {
        const hits = energy >= 3 ? [0, 3, 4, 6] : energy >= 2 ? [0, 4] : [0];
        if (hits.includes(inBar) && !taken) {
          addStereo(drums, taiko(seed()), at(t), levels.taiko - (inBar === 0 ? 0 : 4));
          kicksS.push(t);
        }
        if (!quiet && energy >= 3) tick(t, -6, onBeat ? -0.3 : 0.3);
        // the ostinato: every eighth, the root, octave on the offbeats at full energy
        bassPlay(t, e8 * 0.7, chord.root + (energy >= 3 && !onBeat ? 12 : 0), 0.8);
        break;
      }
      case "minimal": {
        if (onBeat && !taken) playKick(t, levels.kick - 3);
        if (!quiet && energy >= 2 && !onBeat) tick(t, -4, 0.25);
        if (inBar === 0) bassPlay(t, Math.min(8, breathFrom - k) * e8 * 0.98, chord.root, 0.5);
        break;
      }
      case "chill": {
        // half-time: kick on 1 and the "and" of 2, backbeat on 3
        if ((inBar === 0 || inBar === 3) && !taken)
          playKick(t, levels.kick - (inBar === 3 ? 4 : 0));
        if (!quiet && energy >= 2 && inBar === 4) backbeat(t, 2);
        if (!quiet) {
          // swung sixteenths: the in-between one lands late
          tick(t, -6, onBeat ? -0.3 : 0.3);
          if (energy >= 2) tick(t + e8 * 0.62, -10, onBeat ? 0.3 : -0.3);
        }
        if (inBar === 0) bassPlay(t, e8 * 2.6, chord.root, 0.5);
        else if (inBar === 3) bassPlay(t, e8 * 0.9, chord.root, 0.5);
        break;
      }
    }
    // melodic line
    if (kit.arp !== "none" && energy >= arpFrom[kit.style]) {
      const full = energy >= 3;
      if (kit.arp === "pulse" || kit.arp === "bright") {
        const halves = full ? [0, 0.5] : [0];
        for (const half of halves) {
          const step = k * 2 + half * 2;
          const note = chord.arp[step % chord.arp.length]!;
          pluck(
            plucks.L,
            plucks.R,
            at(t + half * e8),
            note + (kit.arp === "bright" ? 12 : 0),
            dbToLin(levels.pluck + (kit.arp === "bright" ? 2 : 0)),
            step % 2 ? 0.35 : -0.35,
            seed(),
          );
        }
      } else if (kit.arp === "mallet") {
        if (full || onBeat) {
          const note = chord.arp[k % chord.arp.length]!;
          malletNote(plucks.L, plucks.R, at(t), note, dbToLin(levels.mallet), k % 2 ? 0.3 : -0.3);
        }
      } else if (kit.arp === "bell") {
        if (onBeat && (full || inBar % 4 === 0)) {
          const note = chord.arp[((k / 2) % chord.arp.length) | 0]! + 12;
          bellNote(
            bells.L,
            bells.R,
            at(t),
            note,
            dbToLin(levels.bell - 2),
            k % 4 ? 0.35 : -0.35,
            1.6,
          );
        }
      }
    }
  };

  const playChord = (
    barStart: number,
    barLen: number,
    chord: Chord,
    energy: Energy,
    e8: number,
  ) => {
    if (kit.pad === "none") return;
    if (kit.pad === "keys") {
      const stabs = energy === 0 ? [0] : [0, 3];
      for (const s8 of stabs)
        if (s8 * e8 < barLen - 0.05)
          keysChord(
            pads.L,
            pads.R,
            at(barStart + s8 * e8),
            chord.pad,
            dbToLin(levels.keys),
            seed(),
          );
      return;
    }
    padChord(
      pads.L,
      pads.R,
      at(barStart),
      barLen,
      chord.pad,
      dbToLin(levels.pad + (kit.pad === "airy" ? -1 : kit.pad === "warm" ? 2 : 0)),
      seed(),
      energy === 0 ? 0.9 : 0.25,
      0.7,
      kit.pad,
    );
  };

  // --- sections -----------------------------------------------------------
  for (const s of sheet.sections) {
    const e8 = 30 / s.bpm;
    const end = s.atS + s.eighths * e8;
    if (s.hit === "big") chordIx = 0;
    if (s.hit) playHit(s.atS, s.hit);
    cutoff.push([s.atS, cut(s.energy) * (s.hit === "big" ? 1.25 : 1)]);

    // one chord per bar; a small hit keeps the loop moving, a big one restarted it
    const bars = Math.ceil(s.eighths / 8);
    const firstChord = chordIx;
    for (let b = 0; b < bars; b++) {
      playChord(s.atS + b * 8 * e8, Math.min(8, s.eighths - b * 8) * e8, chordAt(), s.energy, e8);
      chordIx++;
    }

    const breathFrom = s.eighths - s.breath;
    const buildFrom = s.eighths - s.build;
    for (let k = 0; k < s.eighths; k++) {
      const t = s.atS + k * e8;
      const bar = Math.floor(k / 8);
      const chord = CHORDS[sheet.progression[(firstChord + bar) % sheet.progression.length]!]!;
      if (k < breathFrom)
        perform(t, e8, k, k % 8, s.energy, chord, breathFrom, inClear(t), k === 0 && !!s.hit);
      // the roll into a big hit: the last two beats, 8ths → 16ths → 32nds
      if (s.build && k >= s.eighths - 4 && (kit.build === "pulse" || kit.build === "rise")) {
        const u = (k - (s.eighths - 4)) / 4;
        const hits = u < 0.25 ? 1 : u < 0.75 ? 2 : 4;
        for (let h = 0; h < hits; h++) {
          const th = at(t + (h / hits) * e8);
          if (kit.build === "rise") addStereo(fx, clap(seed()), th, levels.clap - 6 + 6 * u);
          else addStereo(fx, snare(seed()), th, levels.roll - 9 + 9 * u);
        }
      }
    }
    // the build: a riser across the build window, ending on the downbeat
    if (s.build && kit.build !== "minimal") {
      const t0 = s.atS + buildFrom * e8;
      if (kit.build === "rise") {
        const nextChord = CHORDS[sheet.progression[chordIx % sheet.progression.length]!]!;
        addStereo(
          fx,
          pitchRise(
            seed(),
            end - t0,
            nextChord.pad.map((m) => m - 12),
          ),
          at(t0),
          levels.rise,
        );
      } else
        addStereo(
          fx,
          sweep(seed(), end - t0),
          at(t0),
          levels.sweep - (kit.build === "cinematic" ? 3 : 0),
        );
      cutoff.push([t0, cut(s.energy)], [end - 0.02, cut(s.energy) * 1.8]);
    }
    // the breath: the bed pulls back, a reversed cymbal leads into the hit
    if (s.breath) {
      const t0 = s.atS + breathFrom * e8;
      cutoff.push([t0, cut(s.energy) * 0.55]);
      pullBack(t0, end - 0.004, s.build ? -11 : -7);
    }
    const next = sheet.sections[sheet.sections.indexOf(s) + 1];
    const nextHit = next ? next.hit : sheet.outro?.hit;
    if (nextHit) {
      const beats = kit.build === "cinematic" ? 8 : 4;
      const len = Math.min(end - s.atS, beats * e8);
      addStereo(
        fx,
        reverseCymbal(seed(), len),
        at(end - len),
        levels.reverse + (nextHit === "big" ? 2 : 0),
      );
    }
  }

  // --- outro: the final hit, two bars of groove, the resolve ------------------
  if (sheet.outro) {
    const o = sheet.outro;
    const e8 = 30 / o.bpm;
    playHit(o.atS, o.hit);
    chordIx = 0;
    const tail = sheet.durationS - o.atS;
    const grooveBars = tail > 8 * e8 * 2 + 2.2 ? 2 : tail > 8 * e8 + 2.2 ? 1 : 0;
    for (let b = 0; b < grooveBars; b++) {
      const chord = chordAt();
      const t0 = o.atS + b * 8 * e8;
      playChord(t0, 8 * e8, chord, 2, e8);
      for (let k = 0; k < 8; k++)
        perform(t0 + k * e8, e8, b * 8 + k, k, 2, chord, 16, false, b === 0 && k === 0);
      chordIx++;
    }
    cutoff.push([o.atS, cut(2)]);
    // the resolve: the tonic rings, bells answer, and the music ends — within
    // eight seconds, however long the film holds after its last moment
    const resolveAt = o.atS + grooveBars * 8 * e8;
    const tonic = CHORDS[sheet.progression[0]!]!;
    const ring = Math.max(0.5, Math.min(8, sheet.durationS - resolveAt));
    musicEnd = Math.min(n, at(resolveAt + ring));
    if (grooveBars > 0) {
      addStereo(fx, crash(seed(), 2.8), at(resolveAt), levels.crash - 2);
      if (kit.style === "cinematic")
        addStereo(drums, taiko(seed(), true), at(resolveAt), levels.taiko - 2);
      else playKick(resolveAt, levels.kickHit - 3, true);
    }
    if (kit.pad !== "none" && kit.pad !== "keys")
      padChord(
        pads.L,
        pads.R,
        at(resolveAt),
        Math.max(0.3, ring - 1.2),
        tonic.pad,
        dbToLin(levels.pad + 1),
        seed(),
        0.08,
        1.2,
        kit.pad,
      );
    else if (kit.pad === "keys")
      keysChord(
        pads.L,
        pads.R,
        at(resolveAt),
        tonic.pad,
        dbToLin(levels.keys),
        seed(),
        Math.min(ring, 2.5),
      );
    if (kit.bass !== "none")
      bassNote(
        bass,
        at(resolveAt),
        Math.min(ring, 2.4),
        tonic.root,
        dbToLin(levels.bass),
        0.4,
        kit.bass === "pluck" ? "sub" : kit.bass,
      );
    const melody = [76, 72, 69, 64];
    melody.forEach((m, j) => {
      const t = resolveAt + j * 2 * e8;
      if (t < sheet.durationS - 0.4)
        bellNote(bells.L, bells.R, at(t), m, dbToLin(levels.bell), j % 2 ? 0.3 : -0.3);
    });
    cutoff.push([resolveAt, cut(2) * 1.2], [sheet.durationS, cut(1)]);
  }

  // --- the pad's filter follows the energy -------------------------------------
  // each automation point glides from the previous value over 0.35 s, then holds
  cutoff.sort((a, b) => a[0] - b[0]);
  const curve = new Float32Array(n).fill(cutoff[0]?.[1] ?? 1800);
  cutoff.forEach(([t, v], j) => {
    const from = j > 0 ? cutoff[j - 1]![1] : v;
    const s0 = Math.max(0, at(t));
    const s1 = j + 1 < cutoff.length ? Math.min(n, at(cutoff[j + 1]![0])) : n;
    const glide = Math.round(0.35 * SR);
    for (let i = s0; i < s1; i++) {
      const u = Math.min(1, (i - s0) / glide);
      curve[i] = from + (v - from) * (u * u * (3 - 2 * u));
    }
  });
  svf(pads.L, "low", (i) => curve[i]!, 0.8);
  svf(pads.R, "low", (i) => curve[i]!, 0.8);
  // the pad is colour, not weight: keep it out of the bass's octave
  for (const [a, b] of clear) pullBack(a, b, -4);
  svf(pads.L, "high", () => 240, Math.SQRT1_2);
  svf(pads.R, "high", () => 240, Math.SQRT1_2);
  for (const b of [pads, plucks, drums, bells])
    for (let i = 0; i < n; i++) {
      b.L[i]! *= bed[i]!;
      b.R[i]! *= bed[i]!;
    }
  for (let i = 0; i < n; i++) bass[i]! *= bed[i]!;

  // --- pump: everything tonal breathes with the kick ----------------------------
  const pump = kit.style === "pulse" ? 1 : kit.style === "cinematic" ? 0.5 : 0.7;
  const pumpPad = sidechainCurve(n, kicksS, 7 * pump, 0.24);
  const pumpBass = sidechainCurve(n, kicksS, 10 * pump, 0.2);
  const pumpPluck = sidechainCurve(n, kicksS, 4 * pump, 0.18);
  for (let i = 0; i < n; i++) {
    pads.L[i]! *= pumpPad[i]!;
    pads.R[i]! *= pumpPad[i]!;
    bass[i]! *= pumpBass[i]!;
    plucks.L[i]! *= pumpPluck[i]!;
    plucks.R[i]! *= pumpPluck[i]!;
  }

  // --- space ----------------------------------------------------------------
  const [dl, dr] = pingPong(plucks.L, plucks.R, {
    delayS: (3 * 30) / (sheet.outro?.bpm ?? 120) / 2,
    feedback: 0.38,
    damp: 0.35,
  });
  const sendL = new Float32Array(n);
  const sendR = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    sendL[i] = pads.L[i]! * 0.35 + plucks.L[i]! * 0.3 + bells.L[i]! * 0.6 + drums.L[i]! * 0.06;
    sendR[i] = pads.R[i]! * 0.35 + plucks.R[i]! * 0.3 + bells.R[i]! * 0.6 + drums.R[i]! * 0.06;
  }
  const [wl, wr] = reverb(sendL, sendR, { rt60: 2.2, damp: 0.28, preDelayS: 0.022 });
  const ret = dbToLin(levels.reverbReturn);

  const L = new Float32Array(n);
  const R = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    L[i] =
      drums.L[i]! +
      fx.L[i]! +
      pads.L[i]! +
      plucks.L[i]! +
      dl[i]! * 0.4 +
      bells.L[i]! +
      bass[i]! +
      wl[i]! * ret;
    R[i] =
      drums.R[i]! +
      fx.R[i]! +
      pads.R[i]! +
      plucks.R[i]! +
      dr[i]! * 0.4 +
      bells.R[i]! +
      bass[i]! +
      wr[i]! * ret;
  }
  // the final fade: the music ends on silence, not on a cut-off chord —
  // at the film's end, or earlier when the resolve has rung out
  const fade = Math.min(musicEnd, Math.round(1.2 * SR));
  for (let i = 0; i < fade; i++) {
    const g = (i / fade) ** 1.5;
    L[musicEnd - 1 - i]! *= g;
    R[musicEnd - 1 - i]! *= g;
  }
  L.fill(0, musicEnd);
  R.fill(0, musicEnd);
  // DC / rumble out, then the mix's tone: a touch less box, a touch more air
  // (matched by octave-band balance against a reference launch film)
  for (const ch of [L, R]) {
    svf(ch, "high", () => 28, Math.SQRT1_2);
    peakEq(ch, 170, -2.5, 0.9);
    peakEq(ch, 3500, 2.5, 1);
    highShelf(ch, 5000, 4);
  }
  return { pcm: { sampleRate: SR, channels: [L, R] }, kicksS: kicksS.sort((a, b) => a - b), hitsS };
}
