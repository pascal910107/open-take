import type { SoundPalette } from "open-foley";
import type { MotionScene } from "./motion-types";

export type LaunchTransition = { type: "cut" | "fade" | "slide"; durationS?: number };
export type LaunchMotionBlur = { samples: number; shutter: number };

export type LaunchTheme = {
  canvas: string;
  ink: string;
  surface: string;
  accent: string;
  dark: string;
  fontFamily: string;
};

export type SceneBase = {
  id: string;
  durationS: number;
  transition?: LaunchTransition;
  background?: "canvas" | "dark";
  colors?: Partial<LaunchTheme>;
  /** Disable title/end-card entrances while keeping their copy visible. */
  motion?: "on" | "off";
};

export type LaunchTitleScene = SceneBase & {
  type: "title";
  lines: string[];
  brand?: string;
  staggerS?: number;
};

export type LaunchFootageScene = SceneBase & {
  type: "footage";
  asset: string;
  /** The recording this footage came from — a take's composition.json or a
   *  capture.json — so its clicks and keystrokes can be scored (sound). Found
   *  beside the asset by convention when absent (`x.take/composition.json`,
   *  `x.take/capture.json`, `x.composition.json`, `x.capture.json`). */
  take?: string;
  trimStartS?: number;
  fit?: "contain" | "cover";
  frame?: { inset: number; radius: number };
  caption?: string;
};

export type LaunchUiState = {
  icon: "record" | "style" | "refine" | "camera" | "spark" | "target";
  label: string;
  prompt: string;
  transitionS: number;
  typeDelayS: number;
  typeS: number;
  holdS: number;
  panelWidth?: number;
  panelHeight?: number;
};

export type LaunchUiMorphScene = Omit<SceneBase, "durationS"> & {
  type: "ui-morph";
  /** Optional assertion. Omit it to let state timings alone set scene length. */
  durationS?: number;
  states: LaunchUiState[];
  eyebrow?: string;
  panel?: { width: number; compactHeight: number; expandedHeight: number; radius: number };
};

export type LaunchEndCardScene = SceneBase & {
  type: "end-card";
  headline: string;
  brand: string;
  cta: string;
};

export type LaunchScene =
  | LaunchTitleScene
  | LaunchFootageScene
  | LaunchUiMorphScene
  | LaunchEndCardScene
  | MotionScene;

export type LaunchAudioTrack = {
  id: string;
  kind: "music" | "narration" | "sfx";
  asset: string;
  /** Absolute placement, or placement relative to the end of a scene. */
  atS?: number;
  afterSceneId?: string;
  offsetS?: number;
  trimStartS?: number;
  durationS?: number;
  gain?: number;
  fadeInS?: number;
  fadeOutS?: number;
  duckMusic?: boolean;
  /** Music only: repeat the source when shorter than the declared window. */
  loop?: boolean;
};

export type LaunchStoryIntent = "teaser" | "launch" | "walkthrough";
export type LaunchStoryRole = "context" | "promise" | "proof" | "payoff" | "action";
export type LaunchStoryEvidence = {
  kind: "recording" | "screenshot" | "illustration";
  /** Image/video layer in the beat's motion scene. Footage recording may omit this. */
  layerId?: string;
};
export type LaunchStoryBeat = {
  id: string;
  sceneId: string;
  /** Scene-local seconds. Defaults to zero and the scene's full duration. */
  startS?: number;
  endS?: number;
  role: LaunchStoryRole;
  /** Editorial intent, not a claim that this exact copy appears on screen. */
  message: string;
  evidence?: LaunchStoryEvidence[];
};
export type LaunchStory = {
  intent: LaunchStoryIntent;
  audience: string;
  takeaway: string;
  beats: LaunchStoryBeat[];
};

export type LaunchComposition = {
  version: 1;
  output: {
    width: number;
    height: number;
    fps: number;
    /** Motion blur: a centred shutter open for `shutter` of the frame interval
     *  (0.5 = 180°); a frame renders as many times as its motion needs for a
     *  smooth smear, at most `samples` (a still frame renders once). Default
     *  { samples: 16, shutter: 0.5 } on a final render, off in drafts; `false` = off. */
    motionBlur?: LaunchMotionBlur | false;
  };
  theme: LaunchTheme;
  scenes: LaunchScene[];
  audio?: LaunchAudioTrack[];
  story?: LaunchStory;
  /** optional sound design (open-foley): a foley stem spotted from the film's
   *  own timeline and mixed under `audio`. Absent ⇒ no foley. */
  sound?: {
    style: string;
    seed?: number;
    /** the film's sound choices from the vetted palette (`open-foley palette`
     *  lists them); absent ⇒ the default. `music: false` keeps it music-free;
     *  a film with its own music track in `audio` never gets generated music. */
    palette?: SoundPalette;
  };
};

export type LaunchIssue = { severity: "error" | "warn"; path: string; message: string };
