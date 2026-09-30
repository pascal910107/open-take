// The palette's recordings, loaded from disk (the only part of the palette
// that needs Node — palette.ts itself stays importable in a browser, where the
// editor validates a composition's palette).

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FOLEY_ROLES } from "./cues";
import type { Library, LoadedVariant } from "./library";
import { PALETTE, resolvePalette, type SoundPalette } from "./palette";
import { VARIANT_VOICES } from "./variants";
import { decodeWav } from "./wav";

const ASSETS = fileURLToPath(new URL("../assets/palette/", import.meta.url));
const recordingCache = new Map<string, LoadedVariant[]>();

function recordings(folder: string): LoadedVariant[] {
  const hit = recordingCache.get(folder);
  if (hit) return hit;
  const dir = join(ASSETS, folder);
  if (!existsSync(dir))
    throw new Error(`palette: recordings ${JSON.stringify(folder)} are missing`);
  const out = readdirSync(dir)
    .filter((f) => f.endsWith(".wav"))
    .sort()
    .map((f): LoadedVariant => {
      const pcm = decodeWav(readFileSync(join(dir, f)));
      return {
        file: f,
        mono: pcm.channels[0]!,
        sampleRate: pcm.sampleRate,
        // a recording resampled by a semitone stops sounding like the object
        pitchScale: 0.25,
      };
    });
  recordingCache.set(folder, out);
  return out;
}

/** The mixable library for a palette: recordings load as sample variants,
 *  designed voices as voice overrides; the rest stay procedural. */
export function paletteLibrary(p: SoundPalette = {}): Library {
  const resolved = resolvePalette(p);
  const lib: Library = { roles: {}, voices: {} };
  for (const role of FOLEY_ROLES) {
    const id = resolved[role];
    if (!id) continue;
    const entry = PALETTE.find((e) => e.id === id);
    if (!entry) throw new Error(`palette: unknown entry ${JSON.stringify(id)}`);
    const src = entry.source;
    if ("recordings" in src) lib.roles[role] = recordings(src.recordings);
    else if ("variant" in src) {
      if (!VARIANT_VOICES[src.variant]) throw new Error(`palette: unknown voice ${src.variant}`);
      lib.voices![role] = src.variant;
    }
  }
  return lib;
}
