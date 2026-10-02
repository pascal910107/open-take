import type {
  LaunchComposition,
  LaunchScene,
  LaunchUiMorphScene,
  LaunchUiState,
} from "./launch-types";

const clamp = (n: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, n));
export const launchEase = (x: number): number => {
  const p = clamp(x);
  return 1 - (1 - p) ** 3;
};
export const launchSmooth = (x: number): number => {
  const p = clamp(x);
  return p * p * (3 - 2 * p);
};
export const mix = (a: number, b: number, t: number): number => a + (b - a) * t;

export type LaunchSceneWindow = { scene: LaunchScene; index: number; startS: number; endS: number };
export const uiStateDurationS = (state: LaunchUiState): number =>
  Math.max(state.transitionS, state.typeDelayS + state.typeS) + state.holdS;
export const uiMorphDurationS = (scene: LaunchUiMorphScene): number =>
  scene.states.reduce((sum, state) => sum + uiStateDurationS(state), 0);
export const launchSceneDurationS = (scene: LaunchScene): number =>
  scene.type === "ui-morph" ? uiMorphDurationS(scene) : scene.durationS;
export function launchSceneWindows(comp: LaunchComposition): LaunchSceneWindow[] {
  let cursor = 0;
  return comp.scenes.map((scene, index) => {
    const out = { scene, index, startS: cursor, endS: cursor + launchSceneDurationS(scene) };
    cursor = out.endS;
    return out;
  });
}
export const launchDurationS = (comp: LaunchComposition): number =>
  comp.scenes.reduce((sum, scene) => sum + launchSceneDurationS(scene), 0);

export function launchAudioAtS(
  comp: LaunchComposition,
  track: { atS?: number; afterSceneId?: string; offsetS?: number },
): number {
  if (track.atS != null) return track.atS;
  const win = launchSceneWindows(comp).find((x) => x.scene.id === track.afterSceneId);
  return (win?.endS ?? 0) + (track.offsetS ?? 0);
}

export type UiLayerState = {
  from: LaunchUiState;
  to: LaunchUiState;
  progress: number;
  panelWidth: number;
  panelHeight: number;
  chipWidth: number;
  oldOpacity: number;
  oldY: number;
  newOpacity: number;
  newY: number;
  promptChars: number;
  plusX: number;
  sendX: number;
  sendScale: number;
  iconRotation: number;
};

export function evaluateUiMorph(scene: LaunchUiMorphScene, localS: number): UiLayerState {
  const states = scene.states;
  let index = 0;
  let stateStart = 0;
  for (let i = 0, cursor = 0; i < states.length; i++) {
    const end = cursor + uiStateDurationS(states[i]!);
    if (localS < end || i === states.length - 1) {
      index = i;
      stateStart = cursor;
      break;
    }
    cursor = end;
  }
  const to = states[index]!;
  const from = states[Math.max(0, index - 1)]!;
  const transitionS = to.transitionS;
  const p =
    index === 0
      ? launchEase((localS - stateStart) / transitionS)
      : launchSmooth((localS - stateStart) / transitionS);
  const base = scene.panel ?? { width: 1100, compactHeight: 112, expandedHeight: 218, radius: 34 };
  const fromW = from.panelWidth ?? base.width;
  const toW = to.panelWidth ?? base.width;
  const fromH = from.panelHeight ?? (index <= 1 ? base.compactHeight : base.expandedHeight);
  const toH = to.panelHeight ?? (index === 0 ? base.compactHeight : base.expandedHeight);
  const typeStart = stateStart + to.typeDelayS;
  const typed = clamp((localS - typeStart) / Math.max(0.05, to.typeS));
  const width = mix(index === 0 ? fromW * 0.82 : fromW, toW, p);
  const height = mix(index === 0 ? fromH * 0.82 : fromH, toH, p);
  const fromChip = 132 + from.label.length * 11;
  const toChip = 132 + to.label.length * 11;
  const emphasizeStart = stateStart + Math.max(to.transitionS, to.typeDelayS + to.typeS);
  const emphasize =
    index === states.length - 1
      ? Math.sin(
          clamp((localS - emphasizeStart) / Math.min(0.55, Math.max(0.1, to.holdS))) * Math.PI,
        )
      : 0;
  const sameChip = index > 0 && from.icon === to.icon && from.label === to.label;
  return {
    from,
    to,
    progress: p,
    panelWidth: width,
    panelHeight: height,
    chipWidth: mix(fromChip, toChip, p),
    oldOpacity: index === 0 || sameChip ? 0 : 1 - clamp(p / 0.42),
    oldY: -32 * clamp(p / 0.5),
    newOpacity: index === 0 ? p : sameChip ? 1 : clamp((p - 0.35) / 0.65),
    newY: index === 0 || sameChip ? 0 : 32 * (1 - clamp((p - 0.25) / 0.75)),
    promptChars: Math.round(to.prompt.length * typed),
    plusX: -width / 2 - 64,
    sendX: width / 2 - 58,
    sendScale: 1 + 0.06 * emphasize,
    iconRotation: to.icon === "style" ? 12 * (1 - p) : 0,
  };
}

export function transitionOpacity(scene: LaunchScene, localS: number): number {
  if (scene.motion === "off") return 1;
  const t = scene.transition;
  if (!t || t.type === "cut") return 1;
  const duration = launchSceneDurationS(scene);
  const d = Math.min(t.durationS ?? 0.45, duration / 2);
  return Math.min(launchEase(localS / d), launchEase((duration - localS) / d));
}

/**
 * Frame-grid clock helpers.
 *
 * Revideo advances scene time by accumulating 1/fps in floating point, so the
 * clock at frame n sits a hair below n/fps; a `step` keyframe authored exactly on
 * a frame is then reached one frame late. Prepared media carries millisecond
 * timestamps (17, 33, 50 ms …), so seeking an HTMLVideoElement to n/fps lands
 * just before the frame it names and the browser shows the previous one: every
 * third source frame was skipped and the one before it held. Snapping the clock
 * to the grid and seeking to the centre of the intended frame removes both.
 */
export function quantizeToFrame(seconds: number, fps: number): number {
  return Math.round(seconds * fps) / fps;
}
export function frameCentreS(seconds: number, fps: number): number {
  return (Math.round(seconds * fps) + 0.5) / fps;
}
