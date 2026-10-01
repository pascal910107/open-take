// A score the author writes, note by note: open-foley only plays it.
//
// Nothing here chooses anything. Every sound, note, time and level is in the
// sheet; this file renders the instruments (instruments.ts), places the
// recordings (the vetted palette, or the author's own WAVs), sums the tracks,
// ducks one track under another where the sheet asks, and masters the mix to a
// loudness. The same sheet always renders to the same samples.
//
//   { "version": 1, "durationS": 30,
//     "tracks": [
//       { "name": "drums", "events": [ { "at": 0, "drum": "kick" }, { "at": 0.5, "drum": "hat", "gainDb": -20 } ] },
//       { "name": "pad", "gainDb": -4, "events": [ { "at": 0, "note": "pad", "pitch": ["D3", "F#3", "A3"], "dur": 4 } ] },
//       { "name": "ui", "events": [ { "at": 2.3, "sound": "key.brown" }, { "at": 3.1, "sound": "whoosh.medium", "dur": 0.8 } ] } ] }

import { FOLEY_ROLES, type FoleyRole } from "./cues";
import { dbToLin, SR } from "./dsp";
import {
  type BassKind,
  bassNote,
  bellNote,
  clap,
  crash,
  hat,
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
import { voiceFor } from "./library";
import { duck, type Loudness, master, measureLoudness } from "./master";
import { PALETTE } from "./palette";
import { paletteLibrary } from "./palette-library";
import { decodeWav, type Pcm, resample } from "./wav";

export type ScoreSheet = {
  version: 1;
  /** seconds — the mix is cut here (with a short fade) */
  durationS: number;
  /** loudness of the finished mix; `false` leaves every level exactly as written */
  master?: { lufs?: number; truePeakDb?: number } | false;
  tracks: ScoreTrack[];
};

export type ScoreTrack = {
  name: string;
  /** the track's fader, dB (default 0) */
  gainDb?: number;
  /** pull this track down while another track's events sound (music under UI sounds) */
  duck?: { under: string; depthDb?: number; releaseS?: number };
  events: ScoreEvent[];
};

export type ScoreEvent = {
  /** seconds */
  at: number;
  /** the event's peak level, dBFS (default -12) */
  gainDb?: number;
  /** -1 (left) … 1 (right) */
  pan?: number;
  /** seconds the sound lasts (a note's length; a one-shot is cut there) */
  dur?: number;
  /** variation seed: two hits with different seeds are not identical */
  seed?: number;
  /** a vetted recording or voice by id (`open-take sound palette`), or a role name */
  sound?: string;
  /** a WAV of your own, relative to the sheet */
  file?: string;
  /** playback rate for `file` / `sound` (2 = an octave up and twice as fast) */
  rate?: number;
  drum?: DrumName;
  note?: NoteName;
  /** a note name ("F#3"), a MIDI number, or several for a chord */
  pitch?: string | number | (string | number)[];
};

export const DRUMS = [
  "kick",
  "kick-long",
  "snare",
  "clap",
  "hat",
  "open-hat",
  "rim",
  "snap",
  "shaker",
  "taiko",
  "taiko-big",
  "crash",
  "sweep",
  "reverse-cymbal",
] as const;
export type DrumName = (typeof DRUMS)[number];

export const NOTES = [
  "bass",
  "sub-bass",
  "reese-bass",
  "pluck-bass",
  "pad",
  "airy-pad",
  "warm-pad",
  "keys",
  "mallet",
  "pluck",
  "bell",
  "rise",
] as const;
export type NoteName = (typeof NOTES)[number];

/** what each instrument is, for an author choosing one */
export const INSTRUMENT_NOTES: Record<DrumName | NoteName, string> = {
  kick: "tuned electronic kick, short",
  "kick-long": "the same kick with a long tail — a hit",
  snare: "noise snare",
  clap: "layered clap (stereo)",
  hat: "closed hi-hat",
  "open-hat": "open hi-hat",
  rim: "rim click",
  snap: "finger snap",
  shaker: "shaker",
  taiko: "low drum",
  "taiko-big": "big low drum — a hit",
  crash: "crash cymbal (stereo; dur sets its length)",
  sweep: "noise sweep up to the next moment (stereo; dur = its length)",
  "reverse-cymbal": "reversed cymbal swelling into the next moment (stereo; dur = its length)",
  bass: "bass note (pitch, dur)",
  "sub-bass": "sine sub bass (pitch, dur)",
  "reese-bass": "detuned, moving bass (pitch, dur)",
  "pluck-bass": "short plucked bass (pitch, dur)",
  pad: "pad chord (pitch: a chord, dur)",
  "airy-pad": "airy, breathy pad chord",
  "warm-pad": "warm, round pad chord",
  keys: "electric-piano chord (pitch: a chord, dur)",
  mallet: "mallet note (pitch)",
  pluck: "plucked string note (pitch)",
  bell: "bell note (pitch, dur)",
  rise: "pitched riser through the given notes (pitch: a chord, dur)",
};

type Bus = { L: Float32Array; R: Float32Array };

/** a score longer than this is a mistake (an hour of 48 kHz stereo is 1.4 GB of floats) */
const MAX_SCORE_S = 3600;

// a palette entry's recordings are decoded once per process
const libraries = new Map<string, ReturnType<typeof paletteLibrary>>();

export type ScoreRender = {
  pcm: Pcm;
  /** each track as it sits in the mix (after its fader and ducking, before mastering) */
  tracks: { name: string; peakDb: number; loudness: Loudness }[];
  /** the whole mix before and after mastering */
  before: Loudness;
  after: Loudness;
  masterGainDb: number;
};

const NOTE_NAMES: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

/** "C4" → 60, "F#3" → 54, "Bb2" → 46; numbers are MIDI already. */
export function midiOf(p: string | number): number {
  if (typeof p === "number") {
    if (!(Number.isFinite(p) && p >= 0 && p <= 127))
      throw new Error(`pitch ${p}: a MIDI number is 0 … 127`);
    return p;
  }
  const m = /^([a-gA-G])(#|b|♯|♭)?(-?\d)$/.exec(p.trim());
  if (!m)
    throw new Error(`pitch ${JSON.stringify(p)}: write a note name like "F#3" or a MIDI number`);
  const acc = m[2] === "#" || m[2] === "♯" ? 1 : m[2] === "b" || m[2] === "♭" ? -1 : 0;
  return 12 * (Number(m[3]) + 1) + NOTE_NAMES[m[1]!.toLowerCase()]! + acc;
}

export function validateScore(value: unknown): string[] {
  const out: string[] = [];
  const s = value as ScoreSheet;
  if (!s || typeof s !== "object") return ["a score is an object"];
  if (s.version !== 1) out.push("version: must be 1");
  if (
    !(
      typeof s.durationS === "number" &&
      Number.isFinite(s.durationS) &&
      s.durationS > 0 &&
      s.durationS <= MAX_SCORE_S
    )
  )
    out.push(`durationS: seconds, more than 0 and at most ${MAX_SCORE_S}`);
  const finite = (v: unknown) => typeof v === "number" && Number.isFinite(v);
  if (s.master != null && s.master !== false) {
    if (typeof s.master !== "object") out.push("master: an object, or false");
    else {
      const m = s.master;
      if (m.lufs != null && !(finite(m.lufs) && m.lufs >= -60 && m.lufs <= 0))
        out.push("master.lufs: a loudness in LUFS, -60 … 0");
      if (
        m.truePeakDb != null &&
        !(finite(m.truePeakDb) && m.truePeakDb >= -20 && m.truePeakDb <= 0)
      )
        out.push("master.truePeakDb: dBTP, -20 … 0");
    }
  }
  if (!Array.isArray(s.tracks) || !s.tracks.length) {
    out.push("tracks: a list of at least one track");
    return out;
  }
  const names = new Set<string>();
  s.tracks.forEach((t, ti) => {
    const at = `tracks[${ti}]`;
    if (!t || typeof t !== "object") {
      out.push(`${at}: a track object`);
      return;
    }
    if (!t.name) out.push(`${at}.name: required`);
    else if (names.has(t.name)) out.push(`${at}.name: "${t.name}" is used twice`);
    names.add(t.name);
    if (t.gainDb != null && !finite(t.gainDb)) out.push(`${at}.gainDb: a number`);
    if (!Array.isArray(t.events)) {
      out.push(`${at}.events: a list`);
      return;
    }
    t.events.forEach((e, ei) => {
      const where = `${at}.events[${ei}]`;
      if (!e || typeof e !== "object") {
        out.push(`${where}: an event object`);
        return;
      }
      if (!(finite(e.at) && e.at >= 0)) out.push(`${where}.at: seconds ≥ 0`);
      if (e.gainDb != null && !finite(e.gainDb)) out.push(`${where}.gainDb: a number`);
      const kinds = ["sound", "file", "drum", "note"].filter(
        (k) => (e as Record<string, unknown>)[k] != null,
      );
      if (kinds.length !== 1)
        out.push(
          `${where}: exactly one of sound / file / drum / note (got ${kinds.join(", ") || "none"})`,
        );
      // only what a person has heard and approved: a palette entry judged
      // wrong by ear is listed (so the judgement is kept), never playable
      if (
        e.sound != null &&
        !PALETTE.some((p) => p.id === e.sound && p.approved) &&
        !FOLEY_ROLES.includes(e.sound as FoleyRole)
      )
        out.push(
          PALETTE.some((p) => p.id === e.sound)
            ? `${where}.sound: "${e.sound}" was judged wrong by ear and is not playable — see \`open-take sound palette\``
            : `${where}.sound: "${e.sound}" is not a palette id or a role — see \`open-take sound palette\``,
        );
      if (e.drum != null && !DRUMS.includes(e.drum))
        out.push(`${where}.drum: one of ${DRUMS.join(", ")}`);
      if (e.note != null) {
        if (!NOTES.includes(e.note)) out.push(`${where}.note: one of ${NOTES.join(", ")}`);
        if (e.pitch == null) out.push(`${where}.pitch: required for a note`);
        else
          try {
            for (const p of Array.isArray(e.pitch) ? e.pitch : [e.pitch]) midiOf(p);
          } catch (err) {
            out.push(`${where}.${(err as Error).message}`);
          }
      }
      if (e.pan != null && !(finite(e.pan) && e.pan >= -1 && e.pan <= 1))
        out.push(`${where}.pan: -1 … 1`);
      if (e.dur != null && !(finite(e.dur) && e.dur > 0)) out.push(`${where}.dur: seconds > 0`);
      if (e.rate != null && !(finite(e.rate) && e.rate > 0)) out.push(`${where}.rate: > 0`);
      if (e.seed != null && !finite(e.seed)) out.push(`${where}.seed: a number`);
      if (Array.isArray(e.pitch) && !e.pitch.length) out.push(`${where}.pitch: at least one note`);
    });
    if (
      t.duck &&
      (!(
        t.duck.depthDb == null ||
        (finite(t.duck.depthDb) && t.duck.depthDb >= 0 && t.duck.depthDb <= 60)
      ) ||
        !(
          t.duck.releaseS == null ||
          (finite(t.duck.releaseS) && t.duck.releaseS > 0 && t.duck.releaseS <= 5)
        ))
    )
      out.push(`${at}.duck: depthDb 0 … 60, releaseS 0 … 5 s`);
    if (t.duck && !s.tracks.some((o) => o?.name === t.duck!.under))
      out.push(`${at}.duck.under: no track named "${t.duck.under}"`);
  });
  return out;
}

/** Render a score. `readFile` loads a `file` event's WAV (relative paths are
 *  the caller's to resolve). */
export function renderScore(sheet: ScoreSheet, readFile: (path: string) => Buffer): ScoreRender {
  const problems = validateScore(sheet);
  if (problems.length) throw new Error(`score:\n  ${problems.join("\n  ")}`);
  const n = Math.round(sheet.durationS * SR);
  const tail = Math.round(4 * SR); // instruments ring past their note; cut at the end
  const files = new Map<string, Pcm>();
  const buses = new Map<string, Bus>();
  for (const track of sheet.tracks) {
    const bus: Bus = { L: new Float32Array(n + tail), R: new Float32Array(n + tail) };
    track.events.forEach((e, i) => {
      play(bus, e, i, files, readFile);
    });
    const g = dbToLin(track.gainDb ?? 0);
    if (g !== 1) for (const ch of [bus.L, bus.R]) for (let k = 0; k < ch.length; k++) ch[k]! *= g;
    buses.set(track.name, bus);
  }
  // ducking reads the other track's event times, after every bus exists
  for (const track of sheet.tracks) {
    if (!track.duck) continue;
    const under = sheet.tracks.find((t) => t.name === track.duck!.under)!;
    const bus = buses.get(track.name)!;
    const ducked = duck(
      { sampleRate: SR, channels: [bus.L, bus.R] },
      under.events.map((e) => e.at),
      track.duck.depthDb ?? 6,
      track.duck.releaseS ?? 0.14,
    );
    buses.set(track.name, { L: ducked.channels[0]!, R: ducked.channels[1]! });
  }
  const mix: Bus = { L: new Float32Array(n), R: new Float32Array(n) };
  const tracks: ScoreRender["tracks"] = [];
  for (const track of sheet.tracks) {
    const bus = buses.get(track.name)!;
    const L = bus.L.subarray(0, n);
    const R = bus.R.subarray(0, n);
    let peak = 0;
    for (let k = 0; k < n; k++) {
      mix.L[k]! += L[k]!;
      mix.R[k]! += R[k]!;
      peak = Math.max(peak, Math.abs(L[k]!), Math.abs(R[k]!));
    }
    tracks.push({
      name: track.name,
      peakDb: Math.round((peak > 0 ? 20 * Math.log10(peak) : -120) * 10) / 10,
      loudness: measureLoudness({ sampleRate: SR, channels: [L.slice(), R.slice()] }),
    });
  }
  // a mix that simply stops would click: 30 ms out
  const fade = Math.min(n, Math.round(0.03 * SR));
  for (let i = 0; i < fade; i++) {
    mix.L[n - 1 - i]! *= i / fade;
    mix.R[n - 1 - i]! *= i / fade;
  }
  const raw: Pcm = { sampleRate: SR, channels: [mix.L, mix.R] };
  const before = measureLoudness(raw);
  if (sheet.master === false) return { pcm: raw, tracks, before, after: before, masterGainDb: 0 };
  const m = master(raw, {
    lufs: sheet.master?.lufs ?? -16,
    truePeak: sheet.master?.truePeakDb ?? -1.5,
  });
  return { pcm: m.pcm, tracks, before, after: m.after, masterGainDb: m.gainDb };
}

function play(
  bus: Bus,
  e: ScoreEvent,
  index: number,
  files: Map<string, Pcm>,
  readFile: (path: string) => Buffer,
): void {
  const at = Math.round(e.at * SR);
  const db = e.gainDb ?? -12;
  const pan = e.pan ?? 0;
  const seed = e.seed ?? 1000 + index;
  const dur = e.dur;
  if (e.sound != null) {
    const entry = PALETTE.find((p) => p.id === e.sound);
    const role = (entry?.role ?? e.sound) as FoleyRole;
    let library = entry ? libraries.get(entry.id) : undefined;
    if (entry && !library) {
      library = paletteLibrary({ [role]: entry.id });
      libraries.set(entry.id, library);
    }
    let y = voiceFor(role, { sampleRate: SR, durationS: dur ?? 1.5, pitch: 0, seed }, library);
    if (e.rate && e.rate !== 1) y = resample(y, e.rate);
    add(bus, y, at, db, pan);
    return;
  }
  if (e.file != null) {
    let pcm = files.get(e.file);
    if (!pcm) {
      pcm = decodeWav(readFile(e.file));
      files.set(e.file, pcm);
    }
    const ratio = (pcm.sampleRate / SR) * (e.rate ?? 1);
    const chans = pcm.channels.map((c) => resample(c, ratio));
    const cut = dur ? Math.round(dur * SR) : Number.POSITIVE_INFINITY;
    const L = chans[0]!.slice(0, cut);
    const R = (chans[1] ?? chans[0]!).slice(0, cut);
    // a file plays at its own level: gainDb here is a trim (default 0), not a peak
    const g = dbToLin(e.gainDb ?? 0);
    const [gl, gr] = balance(pan);
    addInto(bus.L, L, at, g * gl);
    addInto(bus.R, R, at, g * gr);
    return;
  }
  if (e.drum != null) {
    const d = e.drum;
    const hit: Float32Array | [Float32Array, Float32Array] =
      d === "kick"
        ? kick(seed)
        : d === "kick-long"
          ? kick(seed, 46, true)
          : d === "snare"
            ? snare(seed)
            : d === "clap"
              ? clap(seed)
              : d === "hat"
                ? hat(seed)
                : d === "open-hat"
                  ? hat(seed, true)
                  : d === "rim"
                    ? rim(seed)
                    : d === "snap"
                      ? snap(seed)
                      : d === "shaker"
                        ? shaker(seed)
                        : d === "taiko"
                          ? taiko(seed)
                          : d === "taiko-big"
                            ? taiko(seed, true)
                            : d === "crash"
                              ? crash(seed, dur ?? 2.6)
                              : d === "sweep"
                                ? sweep(seed, dur ?? 1)
                                : reverseCymbal(seed, dur ?? 1);
    add(bus, hit, at, db, pan);
    return;
  }
  if (e.note != null) {
    const pitches = (Array.isArray(e.pitch) ? e.pitch : [e.pitch!]).map(midiOf);
    const g = dbToLin(db);
    const len = dur ?? 1;
    const note = e.note;
    if (note === "bass" || note === "sub-bass" || note === "reese-bass" || note === "pluck-bass") {
      const kind: BassKind =
        note === "sub-bass"
          ? "sub"
          : note === "reese-bass"
            ? "reese"
            : note === "pluck-bass"
              ? "pluck"
              : "pulse";
      // the bass writes into a mono buffer just long enough for this note
      const mono = new Float32Array(Math.round((len + 0.5) * SR));
      for (const p of pitches) bassNote(mono, 0, len, p, g, 1, kind);
      const [gl, gr] = balance(pan);
      addInto(bus.L, mono, at, gl);
      addInto(bus.R, mono, at, gr);
    } else if (note === "pad" || note === "airy-pad" || note === "warm-pad") {
      const kind: PadKind = note === "airy-pad" ? "airy" : note === "warm-pad" ? "warm" : "pulse";
      // a chord renders into its own bus so `pan` can place it (the instrument has no pan)
      place(bus, at, len + 1.5, pan, undefined, (L, R) =>
        padChord(L, R, 0, len, pitches, g, seed, Math.min(0.35, len / 3), 0.7, kind),
      );
    } else if (note === "keys")
      place(bus, at, len + 1.5, pan, undefined, (L, R) =>
        keysChord(L, R, 0, pitches, g, seed, len),
      );
    // a mallet or a pluck rings out on its own; `dur` cuts it short (with a short fade)
    else if (note === "mallet")
      place(bus, at, 3, 0, dur, (L, R) => {
        for (const p of pitches) malletNote(L, R, 0, p, g, pan);
      });
    else if (note === "pluck")
      place(bus, at, 3, 0, dur, (L, R) => {
        for (const p of pitches) pluck(L, R, 0, p, g, pan, seed);
      });
    else if (note === "bell") for (const p of pitches) bellNote(bus.L, bus.R, at, p, g, pan, len);
    else if (note === "rise") add(bus, pitchRise(seed, len, pitches), at, db, pan);
  }
}

/** Render `draw` into a stereo bus of `spanS` seconds, then add it to `bus` at
 *  sample `at`: balanced by `pan`, cut at `cutS` seconds with a 20 ms fade. */
function place(
  bus: Bus,
  at: number,
  spanS: number,
  pan: number,
  cutS: number | undefined,
  draw: (L: Float32Array, R: Float32Array) => void,
): void {
  const n = Math.round(spanS * SR);
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  draw(L, R);
  if (cutS !== undefined) {
    const end = Math.min(n, Math.round(cutS * SR));
    const fade = Math.min(end, Math.round(0.02 * SR));
    for (let i = 0; i < fade; i++) {
      const k = 1 - i / fade;
      L[end - fade + i]! *= k;
      R[end - fade + i]! *= k;
    }
    L.fill(0, end);
    R.fill(0, end);
  }
  const [gl, gr] = pan ? balance(pan) : [1, 1];
  addInto(bus.L, L, at, gl);
  addInto(bus.R, R, at, gr);
}

/** constant-power pan gains, unity at centre */
function balance(pan: number): [number, number] {
  const th = ((pan + 1) / 2) * (Math.PI / 2);
  return [Math.cos(th) * Math.SQRT2, Math.sin(th) * Math.SQRT2];
}

/** a one-shot, peak-normalised by its instrument, placed at `db` peak */
function add(
  bus: Bus,
  src: Float32Array | [Float32Array, Float32Array],
  at: number,
  db: number,
  pan: number,
) {
  const g = dbToLin(db);
  if (src instanceof Float32Array) {
    const [gl, gr] = balance(pan);
    addInto(bus.L, src, at, g * gl);
    addInto(bus.R, src, at, g * gr);
  } else {
    const [gl, gr] = pan ? balance(pan) : [1, 1];
    addInto(bus.L, src[0], at, g * gl);
    addInto(bus.R, src[1], at, g * gr);
  }
}

function addInto(dst: Float32Array, src: Float32Array, at: number, g: number): void {
  const end = Math.min(dst.length, at + src.length);
  for (let i = Math.max(0, at); i < end; i++) dst[i]! += src[i - at]! * g;
}
