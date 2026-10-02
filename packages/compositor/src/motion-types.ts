import type { SceneBase } from "./launch-types";

export type MotionEasing = "linear" | "ease-in" | "ease-out" | "ease-in-out" | "step";
export type MotionProperty =
  | "x"
  | "y"
  | "opacity"
  | "scaleX"
  | "scaleY"
  | "rotation"
  | "width"
  | "height"
  | "radius"
  | "fill"
  | "stroke"
  | "strokeWidth"
  | "fontSize"
  | "reveal"
  | "end";
export type MotionKeyframe = { atS: number; value: number | string; easing?: MotionEasing };
export type MotionTrack = { property: MotionProperty; keyframes: MotionKeyframe[] };
export type MotionLayerBase = {
  id: string;
  x?: number;
  y?: number;
  opacity?: number;
  scaleX?: number;
  scaleY?: number;
  rotation?: number;
  animations?: MotionTrack[];
};
export type MotionShadow = {
  color: string;
  blur: number;
  offsetX?: number;
  offsetY?: number;
};
export type MotionGroupLayer = MotionLayerBase & {
  type: "group";
  children: MotionLayer[];
  width?: number;
  height?: number;
  clip?: boolean;
  /** Rounded clip radius. Only meaningful when clip is true. */
  radius?: number;
};
export type MotionRectLayer = MotionLayerBase & {
  type: "rect";
  width: number;
  height: number;
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  radius?: number;
  shadow?: MotionShadow;
};
export type MotionEllipseLayer = MotionLayerBase & {
  type: "ellipse";
  width: number;
  height: number;
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
};
export type MotionTextLayer = MotionLayerBase & {
  type: "text";
  text: string;
  width: number;
  height: number;
  fontSize: number;
  fontFamily?: string;
  fontWeight?: number;
  fill?: string;
  align?: "left" | "center" | "right";
  /** Line height in design pixels, defaulting to 1.2 * evaluated fontSize. */
  lineHeight?: number;
  reveal?: number;
};
export type MotionImageCrop = { x: number; y: number; width: number; height: number };
export type MotionImageLayer = MotionLayerBase & {
  type: "image";
  asset: string;
  width: number;
  height: number;
  fit?: "contain" | "cover";
  radius?: number;
  crop?: MotionImageCrop;
  shadow?: MotionShadow;
};
export type MotionVideoLayer = MotionLayerBase & {
  type: "video";
  asset: string;
  width: number;
  height: number;
  fit?: "contain" | "cover";
  radius?: number;
  /** First source-media second shown by this layer. Defaults to 0. */
  trimStartS?: number;
  /** Scene-local second when playback begins. Defaults to 0. */
  startS?: number;
  /** Source clip span. The first/last frame hold outside this active span. */
  durationS: number;
  shadow?: MotionShadow;
};
export type MotionLineLayer = MotionLayerBase & {
  type: "line";
  points: [number, number][];
  stroke?: string;
  strokeWidth?: number;
  end?: number;
};
export type MotionLayer =
  | MotionGroupLayer
  | MotionRectLayer
  | MotionEllipseLayer
  | MotionTextLayer
  | MotionImageLayer
  | MotionVideoLayer
  | MotionLineLayer;
export type MotionScene = SceneBase & {
  type: "motion";
  designSize?: { width: number; height: number };
  layers: MotionLayer[];
};

type EvaluatedBase = {
  x: number;
  y: number;
  opacity: number;
  scaleX: number;
  scaleY: number;
  rotation: number;
};
type Evaluated<T> = Omit<T, "animations" | keyof EvaluatedBase> & EvaluatedBase;
export type EvaluatedMotionLayer =
  | (Omit<Evaluated<MotionGroupLayer>, "children"> & {
      children: EvaluatedMotionLayer[];
      clip: boolean;
      radius: number;
    })
  | (Evaluated<MotionRectLayer> & { radius: number; strokeWidth: number })
  | (Evaluated<MotionEllipseLayer> & { strokeWidth: number })
  | (Evaluated<MotionTextLayer> & {
      fullText: string;
      reveal: number;
      align: "left" | "center" | "right";
      fontWeight: number;
      lineHeight: number;
    })
  | (Evaluated<MotionImageLayer> & { fit: "contain" | "cover"; radius: number })
  | (Evaluated<MotionVideoLayer> & {
      fit: "contain" | "cover";
      radius: number;
      trimStartS: number;
      startS: number;
      /** Unquantized source time; the renderer applies only its final-frame sampling guard. */
      mediaTimeS: number;
    })
  | (Evaluated<MotionLineLayer> & { end: number; strokeWidth: number });
export type EvaluatedMotionScene = {
  designSize: { width: number; height: number };
  layers: EvaluatedMotionLayer[];
};
