import type {
  EvaluatedMotionLayer,
  EvaluatedMotionScene,
  MotionEasing,
  MotionLayer,
  MotionScene,
  MotionTrack,
} from "./motion-types";

export type MotionColor = [number, number, number, number];
/** Same explicit color syntax as launch themes; no browser-dependent named colors. */
export function parseMotionColor(value: unknown): MotionColor | undefined {
  if (typeof value !== "string") return undefined;
  if (/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(value))
    return [
      Number.parseInt(value.slice(1, 3), 16),
      Number.parseInt(value.slice(3, 5), 16),
      Number.parseInt(value.slice(5, 7), 16),
      value.length === 9 ? Number.parseInt(value.slice(7, 9), 16) / 255 : 1,
    ];
  const m = value.match(
    /^(rgb|rgba)\(\s*(\d+(?:\.\d+)?|\.\d+)\s*,\s*(\d+(?:\.\d+)?|\.\d+)\s*,\s*(\d+(?:\.\d+)?|\.\d+)(?:\s*,\s*(\d+(?:\.\d+)?|\.\d+))?\s*\)$/i,
  );
  if (!m || (m[1]!.toLowerCase() === "rgba") !== (m[5] !== undefined)) return undefined;
  const rgba: MotionColor = [
    Number(m[2]),
    Number(m[3]),
    Number(m[4]),
    m[5] === undefined ? 1 : Number(m[5]),
  ];
  return rgba.every((n, i) => Number.isFinite(n) && n >= 0 && n <= (i === 3 ? 1 : 255))
    ? rgba
    : undefined;
}
const clamp = (value: number) => Math.max(0, Math.min(1, value));
function ease(t: number, easing: MotionEasing = "linear"): number {
  const p = clamp(t);
  switch (easing) {
    case "ease-in":
      return p ** 3;
    case "ease-out":
      return 1 - (1 - p) ** 3;
    case "ease-in-out":
      return p < 0.5 ? 4 * p ** 3 : 1 - (-2 * p + 2) ** 3 / 2;
    case "step":
      return p < 1 ? 0 : 1;
    default:
      return p;
  }
}
export function evaluateMotionTrack(track: MotionTrack, localS: number): number | string {
  const frames = track.keyframes;
  if (localS <= frames[0]!.atS) return frames[0]!.value;
  for (let i = 1; i < frames.length; i++) {
    const to = frames[i]!,
      from = frames[i - 1]!;
    if (localS > to.atS) continue;
    const p = ease((localS - from.atS) / (to.atS - from.atS), to.easing);
    if (p === 0) return from.value;
    if (p === 1) return to.value;
    if (typeof from.value === "number" && typeof to.value === "number")
      return from.value + (to.value - from.value) * p;
    const a = parseMotionColor(from.value)!,
      b = parseMotionColor(to.value)!;
    const rgba = a.map((n, j) => n + (b[j]! - n) * p);
    return `rgba(${rgba
      .slice(0, 3)
      .map((n) => Number(n.toFixed(4)))
      .join(",")},${Number(rgba[3]!.toFixed(6))})`;
  }
  return frames.at(-1)!.value;
}
const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
export function motionGraphemes(text: string): string[] {
  return Array.from(segmenter.segment(text), (part) => part.segment);
}

/** Input must have passed validation. Evaluation is pure and shared by Node and the browser. */
export function evaluateMotionScene(scene: MotionScene, localS: number): EvaluatedMotionScene {
  const evaluate = (layer: MotionLayer): EvaluatedMotionLayer => {
    const { animations, ...authored } = layer;
    const result: Record<string, unknown> = {
      x: 0,
      y: 0,
      opacity: 1,
      scaleX: 1,
      scaleY: 1,
      rotation: 0,
      ...authored,
    };
    if (scene.motion !== "off")
      for (const track of animations ?? [])
        result[track.property] = evaluateMotionTrack(track, localS);
    if (layer.type === "group") {
      result.children = layer.children.map(evaluate);
      result.clip = layer.clip ?? false;
      result.radius ??= 0;
    }
    if (layer.type === "rect" || layer.type === "image" || layer.type === "video")
      result.radius ??= 0;
    if ((layer.type === "rect" || layer.type === "image" || layer.type === "video") && layer.shadow)
      result.shadow = { ...layer.shadow };
    if (layer.type === "rect" || layer.type === "ellipse") result.strokeWidth ??= 0;
    if (layer.type === "line") {
      result.end ??= 1;
      result.strokeWidth ??= 2;
      result.points = layer.points.map((point) => [...point]);
    }
    if (layer.type === "image") {
      result.fit ??= "contain";
      if (layer.crop) result.crop = { ...layer.crop };
    }
    if (layer.type === "video") {
      result.fit ??= "contain";
      result.trimStartS ??= 0;
      result.startS ??= 0;
      result.mediaTimeS =
        (result.trimStartS as number) +
        Math.max(0, Math.min(layer.durationS, localS - (result.startS as number)));
    }
    if (layer.type === "text") {
      result.fullText = layer.text;
      result.reveal ??= 1;
      result.align ??= "center";
      result.fontWeight ??= 500;
      result.lineHeight = layer.lineHeight ?? (result.fontSize as number) * 1.2;
      const graphemes = motionGraphemes(layer.text);
      result.text = graphemes
        .slice(0, Math.floor(graphemes.length * clamp(result.reveal as number) + 1e-9))
        .join("");
    }
    return result as EvaluatedMotionLayer;
  };
  return {
    designSize: { ...(scene.designSize ?? { width: 1920, height: 1080 }) },
    layers: scene.layers.map(evaluate),
  };
}

/** Visit validated layers in paint order, including nested image assets. */
export function walkMotionLayers(layers: MotionLayer[]): MotionLayer[] {
  return layers.flatMap((layer) =>
    layer.type === "group" ? [layer, ...walkMotionLayers(layer.children)] : [layer],
  );
}
