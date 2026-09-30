import type { SceneBase } from "./launch-types";

/** How a keyframe is approached. Beyond the generic curves, five named curves
 *  carry a MEANING, measured frame by frame off a reference launch film (see
 *  motion-evaluate.ts): `snap` — something arriving (≈90 % of the travel in the
 *  first third, then a long settle); `swift` — an object moving; `glide` — a
 *  camera or a hand moving (symmetric, never overshoots); `spring` — something
 *  landing (≈9 % overshoot, settled by the keyframe); `back` — a small pop past
 *  the target (handles, checkboxes). Exits leave with `ease-in` (accelerate
 *  out), never decelerate. */
export type MotionEasing =
  | "linear"
  | "ease-in"
  | "ease-out"
  | "ease-in-out"
  | "step"
  | "snap"
  | "swift"
  | "glide"
  | "spring"
  | "back";
export const MOTION_EASINGS: readonly MotionEasing[] = [
  "linear",
  "ease-in",
  "ease-out",
  "ease-in-out",
  "step",
  "snap",
  "swift",
  "glide",
  "spring",
  "back",
];
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
  | "end"
  | "rotateX"
  | "rotateY"
  | "z";
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
  /** 3D: tilt about the horizontal / vertical axis (degrees) and depth
   *  (design px, negative = away). Seen through the scene's `perspective`;
   *  rendered by the HTML renderer (motion-only films). */
  rotateX?: number;
  rotateY?: number;
  z?: number;
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
  /** this group is the CAMERA over a recording — the program's framing of it
   *  (take recipes sample the take's own camera into it): its moves are voiced
   *  as the take's camera moves, never as an object sliding */
  camera?: true;
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
  /** Animate the copy unit by unit with named moves (instead of the whole box). */
  units?: MotionTextUnits;
};
/** A named text move. The program owns its distances, curves and blur —
 *  measured off a reference launch film; the author picks the move and when.
 *  Arrivals: `rise` (each unit rises into place through a mask at its line,
 *  1.1 line heights, `snap`), `pop` (settles from 1.18× with a blurred first
 *  frame), `fade`. Exits: `fall` (each unit drops 0.9 line heights, tipping
 *  ±5.5° and blurring as it goes, accelerating), `fade-out`. */
export type MotionTextMoveName = "rise" | "pop" | "fade" | "fall" | "fade-out";
export type MotionTextMove = {
  move: MotionTextMoveName;
  /** scene-local second the first unit starts */
  atS: number;
  /** seconds between consecutive units; defaults per move (rise 0.07) */
  staggerS?: number;
  /** each unit's own duration; defaults per move (rise 0.9) */
  durationS?: number;
};
export type MotionTextUnits = {
  /** words (CJK is segmented into words too) or single graphemes */
  by: "word" | "grapheme";
  /** in time order: at most one arrival, then at most one exit */
  moves: MotionTextMove[];
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
  /** the recording this clip came from (composition.json or capture.json),
   *  for scoring its actions; see LaunchFootageScene.take */
  take?: string;
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
/** A saved screen of the product: the interface at a settled moment of a
 *  recording (`make --states`), drawn again as live DOM — crisp at any zoom,
 *  and addressable element by element. `state` is the saved state's folder
 *  (`<take>.take/states/s3`, relative to the composition); the element ids in
 *  `only` / `hide` come from that folder's index.json. Drawn by the HTML
 *  renderer (films made only of motion scenes). */
export type MotionStateLayer = MotionLayerBase & {
  type: "state";
  state: string;
  width: number;
  height: number;
  /** how the page (or its `crop`) sits in the box, default contain */
  fit?: "contain" | "cover";
  radius?: number;
  shadow?: MotionShadow;
  /** a region of the page in its CSS px (the viewport at capture) */
  crop?: MotionImageCrop;
  /** only these elements and what they contain; the rest of the page, its
   *  background included, turns transparent */
  only?: string[];
  /** these elements disappear; nothing around them moves */
  hide?: string[];
};
/** The pointer of a recording, drawn by the program: open-take's own arrow
 *  (the take renderer's shape and shadow), its TIP at the layer's origin, 24 ×
 *  39 design px at scale 1 — so inside a page group laid out 1:1 in page CSS
 *  px it is the take's cursor. Animate x/y from the recorded actions. */
export type MotionCursorLayer = MotionLayerBase & { type: "cursor" };
export type MotionLineLayer = MotionLayerBase & {
  type: "line";
  points: [number, number][];
  stroke?: string;
  strokeWidth?: number;
  end?: number;
};
/** A plain cover for a section change: a straight edge sweeps across in
 *  `color`, holds, then clears — switch what is underneath while it is
 *  covered (between `atS + durationS` and `atS + durationS + holdS`). A tool
 *  for a real turn in the story, not a flourish: a cut onto a new action, or a
 *  move carried by the product's own interface, is usually the better change. */
export type MotionWipeLayer = MotionLayerBase & {
  type: "wipe";
  /** scene-local second the edge enters */
  atS: number;
  /** the sweep, default 0.45 s */
  durationS?: number;
  /** fully covered, default 0.1 s */
  holdS?: number;
  /** the cover clears, default 0.3 s */
  revealS?: number;
  direction?: "right" | "left";
  /** the cover, default the theme's ink */
  color?: string;
};
export type MotionLayer =
  | MotionWipeLayer
  | MotionGroupLayer
  | MotionRectLayer
  | MotionEllipseLayer
  | MotionTextLayer
  | MotionImageLayer
  | MotionVideoLayer
  | MotionStateLayer
  | MotionCursorLayer
  | MotionLineLayer;
/** A beat that lands hard: the frame shakes (a decaying jitter) and, with
 *  `flash`, blinks white — both gone in a fraction of a second. */
export type MotionHit = {
  /** scene-local second */
  atS: number;
  /** 0–1, default 1 */
  strength?: number;
  /** 0–1 white flash, default 0 */
  flash?: number;
};
export type MotionScene = SceneBase & {
  type: "motion";
  designSize?: { width: number; height: number };
  /** distance of the eye from the stage for 3D layers, design px (default 2800) */
  perspective?: number;
  hits?: MotionHit[];
  layers: MotionLayer[];
};

type EvaluatedBase = {
  x: number;
  y: number;
  opacity: number;
  scaleX: number;
  scaleY: number;
  rotation: number;
  rotateX: number;
  rotateY: number;
  z: number;
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
  | (Evaluated<MotionStateLayer> & { fit: "contain" | "cover"; radius: number })
  | Evaluated<MotionCursorLayer>
  | (Evaluated<MotionLineLayer> & { end: number; strokeWidth: number })
  | (Evaluated<MotionWipeLayer> & {
      /** 0 → 1: where the front is across the frame (0 = entering, 1 = gone past) */
      sweep: number;
      /** 0 → 1 → 0: the cover's opacity (1 while covered) */
      cover: number;
    });
export type EvaluatedMotionScene = {
  designSize: { width: number; height: number };
  layers: EvaluatedMotionLayer[];
};
