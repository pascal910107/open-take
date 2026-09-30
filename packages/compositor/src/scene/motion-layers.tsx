import { blur, Circle, Img, Line, Node, Rect, Txt, Video } from "@revideo/2d";
import { frameCentreS } from "../launch-evaluate";
import {
  CURSOR_ARROW,
  CURSOR_SHADOW,
  CURSOR_UNIT,
  evaluateHits,
  evaluateMotionScene,
  evaluateTextUnit,
  layoutTextUnits,
  type MotionTextSlot,
  motionMediaTimeS,
  motionTextUnits,
  textUnitMaskHeight,
  wipeShape,
} from "../motion-evaluate";
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
  /** scene-local time the layers animate at (a shutter sample under motion blur) */
  localS: () => number;
  /** scene-local time of the output frame, for footage: every shutter sample of
   *  one frame shows the same recorded frame, so recordings never smear */
  frameLocalS?: () => number;
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
  frameLocalS,
  output,
  theme,
}: MotionLayerRendererOptions): Node {
  // design → output scale (canvas blur radii are in output pixels)
  const design = scene.designSize ?? { width: 1920, height: 1080 };
  const fit = Math.min(output.width / design.width, output.height / design.height);
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

    if (authored.type === "text" && authored.units) {
      // Copy that moves unit by unit: every word (or grapheme) is its own node
      // in a mask at its place in the laid-out text; the pure evaluator says
      // where each one is in its move.
      const get = state(authored.id, "text");
      const units = authored.units;
      const lines = motionTextUnits(authored.text, units.by);
      const flat = lines.flat();
      const ctx = document.createElement("canvas").getContext("2d")!;
      let layoutKey = "";
      let slots: MotionTextSlot[] = [];
      const font = () => {
        const l = get();
        return `${l.fontWeight} ${l.fontSize}px ${l.fontFamily ?? theme.fontFamily}`;
      };
      const slotOf = (i: number) => {
        const l = get();
        const key = `${font()}|${l.width}|${l.height}|${l.align}|${l.lineHeight}`;
        if (key !== layoutKey) {
          ctx.font = font();
          slots = layoutTextUnits(
            lines,
            { width: l.width, height: l.height, align: l.align, lineHeight: l.lineHeight },
            (s) => ctx.measureText(s).width,
          );
          layoutKey = key;
        }
        return slots[i]!;
      };
      const box = <Node {...transform(get)} />;
      flat.forEach((unit, i) => {
        const at = () =>
          evaluateTextUnit(units, i, localS(), {
            fontSize: get().fontSize,
            lineHeight: get().lineHeight,
          });
        const mask = (
          <Rect
            position={() => [slotOf(i).cx, slotOf(i).cy]}
            width={() => slotOf(i).width + get().fontSize * 0.2}
            height={() => textUnitMaskHeight(get())}
            clip={() => at().masked}
          />
        );
        mask.add(
          <Txt
            // the trailing space is the gap to the next unit, not part of this one
            text={unit.trimEnd()}
            fontFamily={() => get().fontFamily ?? theme.fontFamily}
            fontSize={() => get().fontSize}
            fontWeight={() => get().fontWeight}
            fill={() => get().fill ?? theme.ink}
            position={() => [at().dx, at().dy]}
            scale={() => at().scale}
            rotation={() => at().rotation}
            opacity={() => at().opacity}
            filters={() => (at().blur > 0.05 ? [blur(at().blur * fit)] : [])}
          />,
        );
        box.add(mask);
      });
      return box;
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
            const media = frameLocalS ? motionMediaTimeS(layer, frameLocalS()) : layer.mediaTimeS;
            // Prepared media runs at the output rate; seek to the centre of the
            // intended frame so millisecond timestamps never select the previous one.
            return frameCentreS(Math.min(media, lastSample), output.fps);
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

    if (authored.type === "cursor") {
      // open-take's arrow, tip at the layer's origin (the take renderer's cursor)
      const get = state(authored.id, "cursor");
      const arrow = (d: number) =>
        CURSOR_ARROW.map(
          ([x, y]) => [x * CURSOR_UNIT + d, y * CURSOR_UNIT + d] as [number, number],
        );
      return (
        <Node {...transform(get)}>
          <Line points={arrow(CURSOR_SHADOW)} closed fill={"rgba(0,0,0,0.35)"} />
          <Line points={arrow(0)} closed fill={"rgb(20,20,24)"} stroke={"white"} lineWidth={2} />
        </Node>
      );
    }

    if (authored.type === "state")
      throw new Error(
        `state layer ${JSON.stringify(authored.id)}: saved screens are drawn by the HTML renderer only`,
      );

    if (authored.type === "wipe") {
      // a plain cover swept across for a section change
      const get = state(authored.id, "wipe");
      return (
        <Node {...transform(get)} opacity={() => get().opacity * get().cover}>
          <Line
            points={() => wipeShape(get(), get().sweep, design.width, design.height).cover}
            closed
            fill={() => get().color ?? theme.ink}
            lineWidth={0}
          />
        </Node>
      );
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

  // hits shake the whole frame and flash it white (scene-level beats)
  const hit = () => evaluateHits(scene.hits, localS());
  const stage = <Node position={() => [hit().dx, hit().dy]} rotation={() => hit().rotation} />;
  for (const layer of scene.layers) stage.add(createLayer(layer));
  const root = <Node scale={[fit, fit]} />;
  root.add(stage);
  if (scene.hits?.some((h) => (h.flash ?? 0) > 0))
    root.add(
      <Rect
        width={design.width}
        height={design.height}
        fill="#ffffff"
        opacity={() => hit().flash}
      />,
    );
  return root;
}
