// Where a role's sound comes from. Every role has its procedural voice; a
// library directory can override any role with WAV files — the path an ear
// takes once it has heard something it likes better (generated, recorded or
// bought). A `library.json` maps roles to variants; a cue's seed picks the
// variant, its pitch resamples it, its duration trims it.
//
//   { "roles": { "impact": [{ "file": "impact-a.wav" }, { "file": "impact-b.wav" }] } }

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { FOLEY_ROLES, type FoleyRole } from "./cues";
import { synthesize, type VoiceParams } from "./synth";
import { synthesizeVariant } from "./variants";
import { decodeWav, resample } from "./wav";

export type LibraryVariant = {
  file: string;
  /** trim the file's head (seconds) */
  trimStartS?: number;
  /** level correction, dB (a file that peaks quiet gets lifted here) */
  gainDb?: number;
};

export type LibraryManifest = {
  roles: Partial<Record<FoleyRole, LibraryVariant[]>>;
};

export type LoadedVariant = LibraryVariant & {
  mono: Float32Array;
  sampleRate: number;
  /** how much of a cue's pitch jitter reaches this file (recordings of real
   *  objects stay near their own pitch); default 1 */
  pitchScale?: number;
};

export type Library = {
  roles: Partial<Record<FoleyRole, LoadedVariant[]>>;
  /** designed voices (variants.ts) standing in for a role's built-in one */
  voices?: Partial<Record<FoleyRole, string>>;
};

/** Load a library manifest and decode its files (once, up front). */
export function loadLibrary(manifestPath: string): Library {
  const abs = resolve(manifestPath);
  const raw = JSON.parse(readFileSync(abs, "utf8")) as LibraryManifest;
  const base = dirname(abs);
  const roles: Library["roles"] = {};
  for (const [role, variants] of Object.entries(raw.roles ?? {})) {
    if (!(FOLEY_ROLES as readonly string[]).includes(role))
      throw new Error(`library: unknown role ${JSON.stringify(role)}`);
    roles[role as FoleyRole] = (variants ?? []).map((v) => {
      const pcm = decodeWav(readFileSync(resolve(base, v.file)));
      const n = pcm.channels[0]!.length;
      const mono = new Float32Array(n);
      for (const ch of pcm.channels)
        for (let i = 0; i < n; i++) mono[i]! += ch[i]! / pcm.channels.length;
      const start = Math.round((v.trimStartS ?? 0) * pcm.sampleRate);
      return { ...v, mono: mono.subarray(Math.min(start, n)), sampleRate: pcm.sampleRate };
    });
  }
  return { roles };
}

/** One rendered cue voice: mono, peak-normalised, at the mix sample rate. */
export function voiceFor(role: FoleyRole, params: VoiceParams, library?: Library): Float32Array {
  const designed = library?.voices?.[role];
  if (designed) return synthesizeVariant(designed, params);
  const variants = library?.roles[role];
  if (!variants || variants.length === 0) return synthesize(role, params);
  const v = variants[params.seed % variants.length]!;
  // pitch: resample by the semitone ratio (a duration change is accepted for SFX)
  const ratio =
    (2 ** ((params.pitch * (v.pitchScale ?? 1)) / 12) * v.sampleRate) / params.sampleRate;
  let y = resample(v.mono, ratio);
  const maxN = Math.round(params.durationS * params.sampleRate);
  if (y.length > maxN && maxN > 0) {
    y = y.slice(0, maxN);
    const fade = Math.min(y.length, Math.round(0.02 * params.sampleRate));
    for (let i = 0; i < fade; i++) y[y.length - 1 - i]! *= i / fade;
  }
  let peak = 0;
  for (let i = 0; i < y.length; i++) peak = Math.max(peak, Math.abs(y[i]!));
  const g = (peak > 0 ? 1 / peak : 1) * 10 ** ((v.gainDb ?? 0) / 20);
  const out = new Float32Array(y.length);
  for (let i = 0; i < y.length; i++) out[i] = y[i]! * g;
  return out;
}
