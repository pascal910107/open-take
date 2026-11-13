// @open-take/compositor — the polish engine (D3). Event log + captured
// frames -> polished mp4 + an editable revideo composition.
//
//   const comp = planComposition(captureLog)   // default editable plan
//   await renderTake({ composition: comp, videoPath, outPath, chromePath })
//
// Edit `comp` (zoom decisions, framing, cursor) and re-render — the
// composition is the editable source of truth.

export {
  type AuditCursorOpts,
  type AuditRow,
  auditCursor,
  auditIssues,
  predictCursorTips,
} from "./audit-cursor";
export { type Beat, directCamera, type Framing } from "./camera";
export {
  FFMPEG_FLOOR,
  FFMPEG_RELEASE,
  resolveFfmpeg,
  resolveFfprobe,
  resolveManagedFfmpeg,
  resolveManagedFfprobe,
  SRGB_TAGS,
} from "./ffmpeg";
export {
  type FilmBeats,
  type FilmBeatsOptions,
  filmBeats,
  formatFilmBeats,
} from "./film/beats";
export {
  checkFilm,
  type FilmCheck,
  type FilmCheckExpect,
  type FilmCheckIssue,
  formatFilmCheck,
  type PageMaterial,
  pageMaterialNote,
  readPageMaterial,
} from "./film/check";
export {
  COMPONENT_ORDER,
  type ComponentAction,
  type ComponentEntry,
  type ComponentProvenance,
  type ComponentRelation,
  type ComponentSource,
  type ComponentSourceKind,
  type ComponentSourceState,
  type ComponentState,
  type ComponentsFile,
  type ComponentTrack,
  type ComponentValue,
  componentCounts,
  componentsLine,
  exampleSource,
  FILM_STAGE,
  fitOf,
  changedLine,
  followedLine,
  formatComponents,
  gatherComponents,
  partsLine,
  phoneOf,
  readComponentSource,
  readNumber,
  writeComponents,
} from "./film/components";
export {
  CLIP_CLEAR_CSS,
  COMPONENT_PROBE_JS,
  type ComponentProbeInput,
  type ComponentProbeResult,
  componentProbeExpression,
  type PartCandidate,
  type PartFields,
  type PartKind,
  type PartSkipped,
  type PartsFile,
  pictureClip,
} from "./film/components-probe";
export {
  type FilmGalleryOptions,
  type FilmGalleryResult,
  filmGallery,
  type GalleryEntry,
  type GalleryMaterial,
  type GalleryStats,
} from "./film/gallery";
export {
  type FilmFiles,
  type FilmInitResult,
  filmInitLines,
  filmKitDir,
  filmStarterDir,
  initFilm,
} from "./film/kit";
export {
  type FilmEvent,
  type FilmEvents,
  type FilmListen,
  type FilmListenOptions,
  filmListen,
  formatFilmListen,
  parseFilmEvents,
} from "./film/listen";
export {
  contrastRatio,
  type FilmLook,
  type FilmLookOptions,
  type FilmLookResult,
  type FontInfo,
  filmLook,
  filmText,
  formatFilmLook,
  glyphChars,
  glyphCoverage,
  packageFonts,
  parseCssColor,
  parseFont,
  readableSize,
  relativeLuminance,
  sizeForCapHeight,
  subsetFont,
  textWidth,
} from "./film/look";
export {
  adHost,
  copyLine,
  formatMaterials,
  imageFileSize,
  imageLine,
  largestSource,
  MATERIALS_PROBE_JS,
  type MaterialCandidate,
  type MaterialImage,
  type MaterialKind,
  type MaterialMeta,
  type MaterialProbeImage,
  type MaterialSheet,
  type MaterialSkipped,
  type MaterialsFile,
  type MaterialsPage,
  type MaterialsProbeResult,
  type MaterialText,
  materialsFromProbe,
  materialsProbeExpression,
  materialsScope,
  materialsSummary,
  pageKey,
  readMaterials,
} from "./film/materials";
export {
  PART_DOM_JS,
  type PartDom,
  type PartDomFile,
  type PartDomInput,
  type PartFileEntry,
  type PartFilesIndex,
  type PartFilesResult,
  partDomExpression,
  partFileName,
  partFilesLine,
  stateFontFaces,
  writePartFiles,
} from "./film/part-files";
export { type FilmPictureOptions, filmPicture } from "./film/picture";
export {
  type FilmProbe,
  type FilmProbeOptions,
  filmProbe,
  formatFilmProbe,
  type SheetSegment,
} from "./film/probe";
export {
  type FilmProvenance,
  numberTokens,
  type ProvenanceValue,
} from "./film/provenance";
export {
  type FilmProgress,
  type FilmRenderOptions,
  type FilmRenderResult,
  type FilmSegment,
  type FilmSource,
  type FilmStillsOptions,
  filmStills,
  muxFilm,
  patchFilm,
  renderFilm,
} from "./film/render";
export {
  type FilmReport,
  type FilmReportOptions,
  filmReport,
  formatFilmReport,
} from "./film/report";
export { type FilmSheetOptions, filmSheet } from "./film/sheet";
export {
  prepareViewer,
  type ViewerRound,
  type ViewerRounds,
  viewerBrief,
  viewerRounds,
} from "./film/viewer";
export {
  evaluateUiMorph,
  launchAudioAtS,
  launchDurationS,
  launchSceneDurationS,
  launchSceneWindows,
  uiMorphDurationS,
  uiStateDurationS,
} from "./launch-evaluate";
export {
  type RenderLaunchOpts,
  type RenderLaunchResult,
  renderLaunch,
  validateLaunchAssets,
} from "./launch-render";
export { launchStarter } from "./launch-starter";
export { analyzeLaunchStory, validateLaunchStory } from "./launch-story";
export { launchTemplate } from "./launch-template";
export * from "./launch-types";
export { formatLaunchIssues, validateLaunchComposition } from "./launch-validate";
export * as math from "./math";
export {
  jpegDimensions,
  matroskaHead,
  mjpegMatroska,
  type TimedFrame,
} from "./mjpeg-matroska";
export { evaluateMotionScene, evaluateMotionTrack, motionGraphemes } from "./motion-evaluate";
export { analyzeMotionQuality } from "./motion-quality";
export {
  type CompareMotionRecipe,
  composeMotionStory,
  type FocusMotionRecipe,
  type MotionRecipe,
  type MotionRecipeImage,
  type MotionRecipeStyle,
  type MotionStoryBrief,
  type MotionStoryResult,
  type StepsMotionRecipe,
} from "./motion-recipes";
export * from "./motion-types";
export { validateMotionScene } from "./motion-validate";
export { type PlanOpts, planComposition } from "./plan";
export * from "./presets";
export { type RenderTakeOpts, type RenderTakeResult, renderTake } from "./render";
export {
  changedBoxes,
  contentOf,
  diffStates,
  elementLabel,
  matchStates,
  type StateChange,
  subtree,
} from "./state-diff";
export { cardsOf, readStateIndex, type StateElement, type StateIndex } from "./state-index";
export * from "./types";
export {
  type CompositionIssue,
  formatIssues,
  type ValidateOpts,
  validateComposition,
} from "./validate";
