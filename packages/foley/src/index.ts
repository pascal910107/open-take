// open-foley — foley for agents. It reads the script, not the pixels.
//
//   const cues = spot(eventSheet, { style: "cinematic" });   // events → cues
//   writeFileSync("foley.wav", mixToWav(cues));               // cues → samples
//
// A client that renders video already knows every moment worth a sound; it
// writes those moments as an event sheet and gets a sample-accurate stem back.

export * from "./cues";
export {
  type Library,
  type LibraryManifest,
  type LibraryVariant,
  loadLibrary,
  voiceFor,
} from "./library";
export {
  duck,
  type FilmMixOpts,
  gain,
  type Loudness,
  limit,
  type Mastered,
  type MasterOpts,
  master,
  measureLoudness,
  mixFilm,
  sumStems,
  truePeakDb,
} from "./master";
export { type CueSummary, type MixOpts, mixCues, mixToWav, peakDb, summarize } from "./mix";
export {
  type ArpPart,
  type ArrangeInput,
  type ArrangeOpts,
  arrange,
  type BassPart,
  type BuildKind,
  type DrumKit,
  type Energy,
  type MusicAnchor,
  type MusicKit,
  type MusicLevels,
  type MusicRender,
  type MusicSection,
  type MusicSheet,
  type MusicStyle,
  type PadPart,
  PULSE_LEVELS,
  renderMusic,
  resolveKit,
  STYLE_KITS,
} from "./music";
export {
  DEFAULT_PALETTE,
  describePalette,
  MUSIC_OPTIONS,
  PALETTE,
  type PaletteEntry,
  type PaletteSource,
  resolvePalette,
  type SoundPalette,
  validatePalette,
} from "./palette";
export { paletteLibrary } from "./palette-library";
export {
  DRUMS,
  type DrumName,
  INSTRUMENT_NOTES,
  midiOf,
  NOTES,
  type NoteName,
  renderScore,
  type ScoreEvent,
  type ScoreRender,
  type ScoreSheet,
  type ScoreTrack,
  validateScore,
} from "./score";
export { type SpotOpts, spot } from "./spot";
export { CINEMATIC, MINIMAL, PLAYFUL, resolveStyle, STYLES, type Style } from "./style";
export { rng, synthesize, VOICES, type VoiceParams } from "./synth";
export { solveTempo, type TempoMap, type TempoOpts, type TempoSpan } from "./tempo";
export { synthesizeVariant, VARIANT_VOICES } from "./variants";
export { decodeWav, encodeWav, type Pcm, resample } from "./wav";
