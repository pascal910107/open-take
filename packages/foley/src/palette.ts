// The palette: which sound each role gets, chosen per film from a library
// of options that have passed a human ear.
//
// Taste is not a single hard-wired sound per role (a film about a calm note
// app and a film about a trading terminal should not tap the same way); it is
// a VETTED set of options, each with a plain description of what it feels
// like. Whoever composes the film — usually an agent — picks from the set by
// what the product is; the program guarantees any pick is one a person has
// already approved, and supplies a default when nobody picks.
//
// Real objects sound like real objects: anything imitating a keyboard, a
// mouse, a trackpad is a RECORDING (CC0, credited in assets/palette/
// CREDITS.md). Synthesis is kept for music and abstract motion sounds.

import { FOLEY_ROLES, type FoleyRole } from "./cues";
import type { ArpPart, BassPart, BuildKind, DrumKit, MusicKit, MusicStyle, PadPart } from "./music";

export type PaletteSource =
  /** the role's built-in procedural voice */
  | { synth: FoleyRole }
  /** a designed alternative voice (variants.ts) */
  | { variant: string }
  /** a folder of recordings under assets/palette */
  | { recordings: string };

export type PaletteEntry = {
  id: string;
  role: FoleyRole;
  source: PaletteSource;
  label: string;
  /** what it feels like and when it fits — the text a chooser reads */
  character: string;
  /** passed a person's ear in an audition; only approved entries can be picked */
  approved: boolean;
  /** approved for use, still being refined */
  provisional?: boolean;
};

export const PALETTE: PaletteEntry[] = [
  {
    id: "key.brown",
    role: "key",
    source: { recordings: "key-brown" },
    label: "mechanical keyboard, brown switches",
    character:
      "a real mechanical keyboard (Cherry MX Brown): a rounded, slightly low clack with a short tail. Warm and physical; the default for typing.",
    approved: true,
  },
  {
    id: "key.blue",
    role: "key",
    source: { recordings: "key-blue" },
    label: "mechanical keyboard, blue switches",
    character:
      "a real mechanical keyboard (Cherry MX Blue): a crisp, bright, dry click. The classic clicky keyboard; for fast, technical, energetic films.",
    approved: true,
  },
  {
    id: "key.office",
    role: "key",
    source: { recordings: "key-office" },
    label: "office keyboard",
    character:
      "a real membrane office keyboard: each key goes down and bottoms out, a soft click-clack. Drier, thinner and brighter than the brown switches.",
    approved: true,
    provisional: true,
  },
  {
    id: "key.crisp",
    role: "key",
    source: { recordings: "key-crisp" },
    label: "crisp light keys",
    character:
      "short, bright, tidy clicks; reads as interface typing more than a physical keyboard. For fast, clean, technical films.",
    approved: true,
    provisional: true,
  },
  {
    id: "tap.wood",
    role: "tap",
    source: { recordings: "tap-wood" },
    label: "wood tap",
    character:
      "a soft, low wooden knock when something appears. Warm and unobtrusive, fine at high density.",
    approved: true,
  },
  {
    id: "click.mouse",
    role: "click",
    source: { recordings: "click-mouse" },
    label: "mouse click",
    character: "a recorded computer mouse click.",
    approved: true,
  },
  {
    id: "whoosh.medium",
    role: "whoosh",
    source: { variant: "whoosh.medium" },
    label: "medium whoosh",
    character: "a swoosh with some body, not heavy. Slides, panels, camera pushes.",
    approved: true,
  },
  {
    id: "whoosh.deep",
    role: "whoosh",
    source: { variant: "whoosh.deep" },
    label: "deep whoosh",
    character: "a heavy swoosh with a sub glide. Judged too heavy for interface moves.",
    approved: false,
  },
  // the payoff stack (pop + impact + boom + chime) as the built-in voices
  ...(["pop", "impact", "boom", "chime"] as const).map(
    (role): PaletteEntry => ({
      id: `${role}.synth`,
      role,
      source: { synth: role },
      label: `${role} (payoff stack)`,
      character: "part of the payoff stack: transient, body, sub and tonal tail on the reveal.",
      approved: true,
    }),
  ),
];

/** Music: every base style and part option has been heard and accepted. */
export const MUSIC_OPTIONS: {
  style: Record<MusicStyle, string>;
  drums: Record<DrumKit, string>;
  bass: Record<BassPart, string>;
  pad: Partial<Record<PadPart, string>>;
  arp: Record<ArpPart, string>;
  build: Record<BuildKind, string>;
} = {
  style: {
    pulse: "four on the floor, a clear beat — a confident product launch (default)",
    cinematic:
      "no drum kit: big low hits on the bar, an eighth-note bass pushing forward — keynote, trailer",
    minimal: "a soft pulse and a pluck line — calm, leaves room for the interface sounds",
    chill: "half-time with electric-piano stabs — relaxed, friendly, lifestyle",
  },
  drums: {
    pulse: "default kit",
    deep: "low, long kick; snaps",
    tight: "short, hard, punchy",
    soft: "round kick, rim, shaker",
  },
  bass: {
    pulse: "sub + filtered octave (default)",
    sub: "pure round sub",
    reese: "two detuned saws, gritty",
    pluck: "short and plucked",
    none: "no bass",
  },
  pad: {
    pulse: "detuned saw pad (default)",
    warm: "rounder and darker",
    keys: "electric-piano chords, played",
    none: "no pad",
  },
  arp: {
    pulse: "saw pluck sixteenths (default)",
    mallet: "marimba-like",
    bell: "sparse FM bells",
    bright: "pluck an octave up",
    none: "no arpeggio",
  },
  build: {
    cinematic: "long reversed cymbal, low drum and sub on the hit (default)",
    pulse: "noise riser, snare roll, crash",
    minimal: "reversed cymbal only",
    rise: "a chord gliding up, clap roll",
  },
};

export type SoundPalette = Partial<Record<FoleyRole, string>> & {
  /** the band, or `false` for no music */
  music?: MusicKit | false;
};

/** What a film gets when nobody picks: the choices from Pascal's audition. */
export const DEFAULT_PALETTE: Readonly<SoundPalette> = {
  key: "key.brown",
  tap: "tap.wood",
  click: "click.mouse",
  whoosh: "whoosh.medium",
  music: { style: "pulse", build: "cinematic" },
};

export function resolvePalette(p: SoundPalette = {}): SoundPalette {
  const music =
    p.music === false ? false : { ...(DEFAULT_PALETTE.music as MusicKit), ...(p.music ?? {}) };
  return { ...DEFAULT_PALETTE, ...p, music };
}

export function validatePalette(value: unknown): string[] {
  const issues: string[] = [];
  if (value === undefined) return issues;
  if (!value || typeof value !== "object") return ["palette must be an object"];
  for (const [role, id] of Object.entries(value as Record<string, unknown>)) {
    if (role === "music") {
      if (id === false) continue;
      if (!id || typeof id !== "object") {
        issues.push("palette.music must be an object or false");
        continue;
      }
      for (const [k, v] of Object.entries(id as Record<string, unknown>)) {
        const opts = (MUSIC_OPTIONS as Record<string, Record<string, string>>)[k];
        if (!opts) issues.push(`palette.music.${k}: unknown part`);
        else if (typeof v !== "string" || !(v in opts))
          issues.push(`palette.music.${k}: one of ${Object.keys(opts).join(", ")}`);
      }
      continue;
    }
    if (!(FOLEY_ROLES as readonly string[]).includes(role)) {
      issues.push(`palette.${role}: unknown role`);
      continue;
    }
    const entry = PALETTE.find((e) => e.id === id);
    if (!entry) issues.push(`palette.${role}: unknown entry ${JSON.stringify(id)}`);
    else if (entry.role !== role)
      issues.push(`palette.${role}: ${entry.id} is a ${entry.role} sound`);
    else if (!entry.approved)
      issues.push(`palette.${role}: ${entry.id} has not been approved by ear`);
  }
  return issues;
}

/** The palette as text for whoever chooses: every approved option per role,
 *  what it feels like, and the default. */
export function describePalette(): string {
  const lines: string[] = [
    "Sound palette — pick per film by what the product feels like; defaults in [brackets].",
    "",
  ];
  const roles = [...new Set(PALETTE.filter((e) => e.approved).map((e) => e.role))];
  for (const role of roles) {
    lines.push(`${role}:`);
    for (const e of PALETTE.filter((x) => x.role === role && x.approved)) {
      const def = DEFAULT_PALETTE[role] === e.id ? " [default]" : "";
      lines.push(`  ${e.id}${def}${e.provisional ? " (provisional)" : ""} — ${e.character}`);
    }
  }
  lines.push("", "music (palette.music; false = no music):");
  for (const [part, opts] of Object.entries(MUSIC_OPTIONS)) {
    const def = (DEFAULT_PALETTE.music as Record<string, string>)[part];
    lines.push(
      `  ${part}: ${Object.entries(opts)
        .map(([k, v]) => `${k}${k === def || (!def && k === "pulse") ? "*" : ""} (${v})`)
        .join(" · ")}`,
    );
  }
  return lines.join("\n");
}
