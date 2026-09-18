import { Circle, Img, Line, Node, Rect, Txt, Video } from "@revideo/2d";
import { frameCentreS } from "../launch-evaluate";
import { evaluateMotionScene } from "../motion-evaluate";
import type { EvaluatedMotionLayer, MotionLayer, MotionScene } from "../motion-types";

export type MotionLayerTheme = {
  ink: string;
  surface: string;
  accent: string;
  fontFamily: string;
};

type MotionLayerType = MotionLayer["type"];
type EvaluatedLayerOf<T extends MotionLayerType> = Extract<EvaluatedMotionLayer, { type: T }>;
type LayerState<T extends MotionLayerType> = () => EvaluatedLayerOf<T>;

type MotionLayerRendererOptions = {
  scene: MotionScene;
  localS: () => number;
  output: { width: number; height: number; fps: number };
  theme: MotionLayerTheme;
};

/** Revideo exposes normal wrapping and preformatted text separately; motion
 * text needs both automatic wrapping and authored editorial line breaks. */
class WrappedTxt extends Txt {
  protected override applyFont(): void {
    super.applyFont();
    this.element.style.whiteSpace = "pre-wrap";
    this.element.style.overflowWrap = "anywhere";
  }
}

/** Video does not expose its decoded pixel size, but fit needs that size after
 * readiness. This signal is reevaluated with scene time, so the initial 0x0
 * state is replaced as soon as the stable media element has metadata. */
class FittedVideo extends Video {
  public sourceSize(): [number, number] {
    const media = this.mediaElement() as HTMLVideoElement;
    return [media.videoWidth, media.videoHeight];
  }
}

/**
 * Build stable Revideo nodes whose signals read from the shared pure evaluator.
 * The evaluator is cached once per local timeline value so every node observes
 * one coherent tree without duplicating easing or interpolation in the scene.
 */
export function createMotionLayers({
  scene,
  localS,
  output,
  theme,
}: MotionLayerRendererOptions): Node {
  let cachedS = Number.NaN;
  let byId = new Map<string, EvaluatedMotionLayer>();

  const evaluateFrame = () => {
    const time = localS();
    if (time !== cachedS) {
      cachedS = time;
      byId = new Map();
      const visit = (layers: EvaluatedMotionLayer[]) => {
        for (const layer of layers) {
          byId.set(layer.id, layer);
          if (layer.type === "group") visit(layer.children);
        }
      };
      visit(evaluateMotionScene(scene, time).layers);
    }
  };

  const state =
    <T extends MotionLayerType>(id: string, type: T): LayerState<T> =>
    () => {
      evaluateFrame();
      const layer = byId.get(id);
      if (!layer || layer.type !== type) {
        throw new Error(`motion layer ${id} is missing from the evaluated ${type} tree`);
      }
      return layer as EvaluatedLayerOf<T>;
    };

  const transform = <T extends MotionLayerType>(get: LayerState<T>) => ({
    position: () => [get().x, get().y] as [number, number],
    opacity: () => get().opacity,
    scale: () => [get().scaleX, get().scaleY] as [number, number],
    rotation: () => get().rotation,
  });

  const createLayer = (authored: MotionLayer): Node => {
    if (authored.type === "group") {
      const get = state(authored.id, "group");
      const group = authored.clip ? (
        <Rect
          {...transform(get)}
          width={() => get().width ?? 0}
          height={() => get().height ?? 0}
          radius={() => get().radius}
          clip
        />
      ) : (
        <Node {...transform(get)} />
      );
      for (const child of authored.children) group.add(createLayer(child));
      return group;
    }

    if (authored.type === "rect") {
      const get = state(authored.id, "rect");
      return (
        <Rect
          {...transform(get)}
          width={() => get().width}
          height={() => get().height}
          radius={() => get().radius}
          fill={() => get().fill ?? theme.surface}
          stroke={() => get().stroke ?? theme.accent}
          lineWidth={() => get().strokeWidth}
          shadowColor={() => get().shadow?.color ?? "rgba(0,0,0,0)"}
          shadowBlur={() => get().shadow?.blur ?? 0}
          shadowOffset={() => [get().shadow?.offsetX ?? 0, get().shadow?.offsetY ?? 0]}
        />
      );
    }

    if (authored.type === "ellipse") {
      const get = state(authored.id, "ellipse");
      return (
        <Circle
          {...transform(get)}
          width={() => get().width}
          height={() => get().height}
          fill={() => get().fill ?? theme.surface}
          stroke={() => get().stroke ?? theme.accent}
          lineWidth={() => get().strokeWidth}
        />
      );
    }

    if (authored.type === "text") {
      const get = state(authored.id, "text");
      const box = (
        <Rect {...transform(get)} width={() => get().width} height={() => get().height} clip />
      );
      const text = (
        <WrappedTxt
          text=""
          width={() => get().width}
          height={() => get().height}
          fontFamily={() => get().fontFamily ?? theme.fontFamily}
          fontSize={() => get().fontSize}
          fontWeight={() => get().fontWeight}
          lineHeight={() => get().lineHeight}
          textAlign={() => get().align}
          fill={() => get().fill ?? theme.ink}
        />
      ) as Txt;
      // Txt's constructor interprets function-valued text as children. Binding
      // after construction routes the signal through TxtLeaf as intended.
      text.text(() => get().text);
      box.add(text);
      return box;
    }

    if (authored.type === "image") {
      const get = state(authored.id, "image");
      const frame = (
        <Rect
          {...transform(get)}
          width={() => get().width}
          height={() => get().height}
          radius={() => get().radius}
          clip
          shadowColor={() => get().shadow?.color ?? "rgba(0,0,0,0)"}
          shadowBlur={() => get().shadow?.blur ?? 0}
          shadowOffset={() => [get().shadow?.offsetX ?? 0, get().shadow?.offsetY ?? 0]}
        />
      );
      const image = (<Img src={authored.asset} />) as Img;
      const fittedSize = () => {
        const layer = get();
        const natural = image.naturalSize();
        if (natural.x <= 0 || natural.y <= 0) {
          return [layer.width, layer.height] as [number, number];
        }
        const fit =
          layer.fit === "cover"
            ? Math.max(layer.width / natural.x, layer.height / natural.y)
            : Math.min(layer.width / natural.x, layer.height / natural.y);
        return [natural.x * fit, natural.y * fit] as [number, number];
      };
      image.size(fittedSize);
      frame.add(image);
      return frame;
    }

    if (authored.type === "video") {
      const get = state(authored.id, "video");
      const frame = (
        <Rect
          {...transform(get)}
          width={() => get().width}
          height={() => get().height}
          radius={() => get().radius}
          clip
          shadowColor={() => get().shadow?.color ?? "rgba(0,0,0,0)"}
          shadowBlur={() => get().shadow?.blur ?? 0}
          shadowOffset={() => [get().shadow?.offsetX ?? 0, get().shadow?.offsetY ?? 0]}
        />
      );
      const video = (
        <FittedVideo
          src={authored.asset}
          decoder="slow"
          volume={0}
          time={() => {
            const layer = get();
            const lastSample = layer.trimStartS + Math.max(0, layer.durationS - 1 / output.fps);
            // Prepared media runs at the output rate; seek to the centre of the
            // intended frame so millisecond timestamps never select the previous one.
            return frameCentreS(Math.min(layer.mediaTimeS, lastSample), output.fps);
          }}
        />
      ) as FittedVideo;
      const fittedSize = () => {
        const layer = get();
        const [width, height] = video.sourceSize();
        if (width <= 0 || height <= 0) {
          return [layer.width, layer.height] as [number, number];
        }
        const fit =
          layer.fit === "cover"
            ? Math.max(layer.width / width, layer.height / height)
            : Math.min(layer.width / width, layer.height / height);
        return [width * fit, height * fit] as [number, number];
      };
      video.size(fittedSize);
      frame.add(video);
      return frame;
    }

    const get = state(authored.id, "line");
    return (
      <Line
        {...transform(get)}
        points={authored.points}
        opacity={() => (get().end > 0 ? get().opacity : 0)}
        stroke={() => get().stroke ?? theme.accent}
        lineWidth={() => get().strokeWidth}
        end={() => get().end}
        lineCap="round"
        lineJoin="round"
      />
    );
  };

  const design = scene.designSize ?? { width: 1920, height: 1080 };
  const fit = Math.min(output.width / design.width, output.height / design.height);
  const root = <Node scale={[fit, fit]} />;
  for (const layer of scene.layers) root.add(createLayer(layer));
  return root;
}
