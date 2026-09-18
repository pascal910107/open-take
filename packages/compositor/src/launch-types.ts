import type { MotionScene } from "./motion-types";

export type LaunchTransition = { type: "cut" | "fade" | "slide"; durationS?: number };

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
  output: { width: number; height: number; fps: number };
  theme: LaunchTheme;
  scenes: LaunchScene[];
  audio?: LaunchAudioTrack[];
  story?: LaunchStory;
};

export type LaunchIssue = { severity: "error" | "warn"; path: string; message: string };
