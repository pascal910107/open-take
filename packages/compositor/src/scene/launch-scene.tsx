import { Circle, Line, makeScene2D, Node, Rect, Txt, Video } from "@revideo/2d";
import { createSignal, linear, tween } from "@revideo/core";
import {
  evaluateUiMorph,
  launchEase,
  launchSceneWindows,
  transitionOpacity,
} from "../launch-evaluate";
import comp from "./.launch-composition.json";
import { createMotionLayers } from "./motion-layers";

const W = comp.output.width,
  H = comp.output.height;
const sx = W / 1920,
  sy = H / 1080,
  k = Math.min(sx, sy);
const windows = launchSceneWindows(comp);
const color = (scene, key) => scene.colors?.[key] ?? comp.theme[key];
const bg = (scene) => (scene.background === "dark" ? color(scene, "dark") : color(scene, "canvas"));
const fg = (scene) => (scene.background === "dark" ? color(scene, "canvas") : color(scene, "ink"));
const wrap = (text, max = 34) => {
  if (text.length <= max) return text;
  const words = text.split(" ");
  let line = "",
    out = [];
  for (const word of words) {
    if ((line + " " + word).trim().length > max) {
      out.push(line);
      line = word;
    } else line = (line + " " + word).trim();
  }
  if (line) out.push(line);
  return out.join("\n");
};
const sceneLocal = (t, win) => t - win.startS;

function Icon({ icon, color, size }) {
  const s = size / 24;
  if (icon === "record" || icon === "camera")
    return (
      <Node>
        <Rect width={18 * s} height={13 * s} radius={3 * s} stroke={color} lineWidth={2.2 * s} />
        <Circle size={6 * s} stroke={color} lineWidth={2 * s} />
      </Node>
    );
  if (icon === "style" || icon === "spark")
    return (
      <Node>
        <Line
          points={[
            [0, -10 * s],
            [0, 10 * s],
          ]}
          stroke={color}
          lineWidth={2 * s}
        />
        <Line
          points={[
            [-10 * s, 0],
            [10 * s, 0],
          ]}
          stroke={color}
          lineWidth={2 * s}
        />
        <Line
          points={[
            [-7 * s, -7 * s],
            [7 * s, 7 * s],
          ]}
          stroke={color}
          lineWidth={1.5 * s}
        />
        <Line
          points={[
            [7 * s, -7 * s],
            [-7 * s, 7 * s],
          ]}
          stroke={color}
          lineWidth={1.5 * s}
        />
      </Node>
    );
  return (
    <Node>
      <Circle size={19 * s} stroke={color} lineWidth={2 * s} />
      <Circle size={8 * s} stroke={color} lineWidth={2 * s} />
      <Circle size={2.8 * s} fill={color} />
    </Node>
  );
}

export default makeScene2D("launch", function* (view) {
  const t = createSignal(0);
  const sceneAt = () =>
    windows.find((item) => t() >= item.startS && t() < item.endS)?.scene ?? windows.at(-1).scene;
  view.add(<Rect width={W} height={H} fill={() => bg(sceneAt())} />);
  for (const win of windows) {
    const scene = win.scene;
    const font = scene.colors?.fontFamily ?? comp.theme.fontFamily;
    const active = () => t() >= win.startS && t() < win.endS;
    const local = () => sceneLocal(t(), win);
    const opacity = () => (active() ? transitionOpacity(scene, local()) : 0);
    const slide = () =>
      scene.motion !== "off" && scene.transition?.type === "slide"
        ? (1 - launchEase(Math.min(1, local() / (scene.transition.durationS ?? 0.5)))) * 42 * k
        : 0;
    const root = <Node opacity={opacity} position={() => [0, slide()]} />;
    if (scene.type === "title") {
      const lines = scene.lines;
      lines.forEach((line, i) => {
        root.add(
          <Txt
            text={line}
            fontFamily={scene.colors?.fontFamily ?? comp.theme.fontFamily}
            fontSize={(lines.length > 2 ? 92 : 112) * k}
            fontWeight={600}
            letterSpacing={-3 * k}
            fill={fg(scene)}
            position={[0, (i - (lines.length - 1) / 2) * 120 * k]}
            opacity={() =>
              scene.motion === "off"
                ? 1
                : active()
                  ? launchEase((local() - 0.18 - i * (scene.staggerS ?? 0.36)) / 0.45)
                  : 0
            }
            y={() =>
              (i - (lines.length - 1) / 2) * 120 * k +
              (scene.motion === "off"
                ? 0
                : 26 * k * (1 - launchEase((local() - 0.18 - i * (scene.staggerS ?? 0.36)) / 0.45)))
            }
          />,
        );
      });
      if (scene.brand)
        root.add(
          <Txt
            text={scene.brand}
            fontFamily={font}
            fontSize={28 * k}
            fontWeight={600}
            letterSpacing={4 * k}
            fill={fg(scene)}
            position={[-W / 2 + 76 * k, -H / 2 + 64 * k]}
            offset={[-1, -1]}
          />,
        );
    } else if (scene.type === "footage") {
      const inset = (scene.frame?.inset ?? 86) * k;
      const fw = W - 2 * inset,
        fh = H - 2 * inset;
      root.add(
        <Rect
          width={fw}
          height={fh}
          radius={(scene.frame?.radius ?? 28) * k}
          clip
          fill="#08100e"
          shadowColor="rgba(0,0,0,.22)"
          shadowBlur={40 * k}
          shadowOffset={[0, 18 * k]}
        >
          <Video
            src={scene.asset}
            time={() =>
              (scene.trimStartS ?? 0) +
              Math.max(0, Math.min(scene.durationS - 1 / comp.output.fps, local()))
            }
            alpha={() => (active() ? 1 : 0)}
            decoder="slow"
            width={fw}
            height={fh}
          />
        </Rect>,
      );
      if (scene.caption)
        root.add(
          <Rect
            layout
            padding={[15 * k, 24 * k]}
            radius={999}
            fill={scene.background === "dark" ? "rgba(245,242,234,.92)" : "rgba(23,46,40,.92)"}
            position={[0, H / 2 - 70 * k]}
            offset={[0, 1]}
          >
            <Txt
              text={scene.caption}
              fontFamily={font}
              fontSize={34 * k}
              fontWeight={600}
              fill={scene.background === "dark" ? comp.theme.ink : comp.theme.canvas}
            />
          </Rect>,
        );
    } else if (scene.type === "ui-morph") {
      const ev = () => evaluateUiMorph(scene, local());
      const panelY = 20 * k;
      const intro = () => launchEase(local() / 0.55);
      const panel = (
        <Rect
          width={() => ev().panelWidth * k}
          height={() => ev().panelHeight * k}
          radius={(scene.panel?.radius ?? 34) * k}
          fill={scene.colors?.surface ?? comp.theme.surface}
          position={() => [0, panelY + 24 * k * (1 - intro())]}
          scale={() => [0.97 + 0.03 * intro(), 0.97 + 0.03 * intro()]}
          opacity={intro}
          shadowColor="rgba(23,46,40,.12)"
          shadowBlur={34 * k}
          shadowOffset={[0, 14 * k]}
        />
      );
      root.add(panel);
      const chipY = () => panelY - (ev().panelHeight * k) / 2 + 48 * k;
      const chipWidth = () => ev().chipWidth * k;
      root.add(
        <Rect
          width={chipWidth}
          height={52 * k}
          radius={26 * k}
          fill={scene.colors?.canvas ?? comp.theme.canvas}
          position={() => [(-ev().panelWidth * k) / 2 + chipWidth() / 2 + 30 * k, chipY()]}
        />,
      );
      scene.states.forEach((state) => {
        const currentOpacity = () =>
          ev().to === state
            ? ev().newOpacity
            : ev().from === state && ev().from !== ev().to
              ? ev().oldOpacity
              : 0;
        const stateY = () => (ev().to === state ? ev().newY * k : ev().oldY * k);
        root.add(
          <Node
            position={() => [(-ev().panelWidth * k) / 2 + 58 * k, chipY() + stateY()]}
            rotation={() => (ev().to === state ? ev().iconRotation : 0)}
            opacity={currentOpacity}
          >
            <Icon
              icon={state.icon}
              color={scene.colors?.accent ?? comp.theme.accent}
              size={24 * k}
            />
          </Node>,
        );
        root.add(
          <Txt
            text={state.label}
            fontFamily={font}
            fontSize={30 * k}
            fontWeight={600}
            fill={scene.colors?.accent ?? comp.theme.accent}
            position={() => [(-ev().panelWidth * k) / 2 + 87 * k, chipY() + stateY()]}
            offset={[-1, 0]}
            opacity={currentOpacity}
          />,
        );
      });
      root.add(
        <Txt
          text="×"
          fontFamily={font}
          fontSize={30 * k}
          fill={scene.colors?.accent ?? comp.theme.accent}
          position={() => [(-ev().panelWidth * k) / 2 + chipWidth() + 14 * k, chipY()]}
          opacity={() => ev().newOpacity}
        />,
      );
      const promptPosition = () => [
        (-ev().panelWidth * k) / 2 + 34 * k,
        panelY + (ev().panelHeight * k) / 2 - 58 * k,
      ];
      const oldPrompt = (
        <Txt
          text=""
          fontFamily={scene.colors?.fontFamily ?? comp.theme.fontFamily}
          fontSize={46 * k}
          fontWeight={500}
          fill={scene.colors?.ink ?? comp.theme.ink}
          position={promptPosition}
          offset={[-1, 0]}
          opacity={() => ev().oldOpacity}
        />
      );
      oldPrompt.text(() => ev().from.prompt);
      root.add(oldPrompt);
      const newPrompt = (
        <Txt
          text=""
          fontFamily={scene.colors?.fontFamily ?? comp.theme.fontFamily}
          fontSize={46 * k}
          fontWeight={500}
          fill={scene.colors?.ink ?? comp.theme.ink}
          position={promptPosition}
          offset={[-1, 0]}
        />
      );
      newPrompt.text(() => ev().to.prompt.slice(0, ev().promptChars));
      root.add(newPrompt);
      root.add(
        <Circle
          size={54 * k}
          fill={scene.colors?.accent ?? comp.theme.accent}
          position={() => [ev().sendX * k, panelY + (ev().panelHeight * k) / 2 - 58 * k]}
          scale={() => [ev().sendScale, ev().sendScale]}
          opacity={() => launchEase((local() - 0.08) / 0.47)}
        >
          <Line
            points={[
              [0, 8 * k],
              [0, -8 * k],
              [-7 * k, -1 * k],
              [0, -8 * k],
              [7 * k, -1 * k],
            ]}
            stroke={scene.colors?.canvas ?? comp.theme.canvas}
            lineWidth={3 * k}
            lineCap="round"
            lineJoin="round"
          />
        </Circle>,
      );
      root.add(
        <Circle
          size={52 * k}
          fill={scene.colors?.surface ?? comp.theme.surface}
          position={() => [ev().plusX * k, panelY]}
          opacity={() => launchEase((local() - 0.08) / 0.47)}
        >
          <Txt
            text="+"
            fontFamily={font}
            fontSize={40 * k}
            fontWeight={400}
            fill={scene.colors?.accent ?? comp.theme.accent}
          />
        </Circle>,
      );
      if (scene.eyebrow)
        root.add(
          <Txt
            text={scene.eyebrow}
            fontFamily={scene.colors?.fontFamily ?? comp.theme.fontFamily}
            fontSize={22 * k}
            fontWeight={600}
            letterSpacing={5 * k}
            fill={scene.colors?.accent ?? comp.theme.accent}
            opacity={0.52}
            position={[0, -220 * k]}
          />,
        );
    } else if (scene.type === "motion") {
      root.add(
        createMotionLayers({
          scene,
          localS: local,
          output: comp.output,
          theme: {
            ink: scene.colors?.ink ?? comp.theme.ink,
            surface: scene.colors?.surface ?? comp.theme.surface,
            accent: scene.colors?.accent ?? comp.theme.accent,
            fontFamily: scene.colors?.fontFamily ?? comp.theme.fontFamily,
          },
        }),
      );
    } else {
      root.add(
        <Txt
          text={wrap(scene.headline, 30)}
          fontFamily={scene.colors?.fontFamily ?? comp.theme.fontFamily}
          fontSize={92 * k}
          fontWeight={600}
          lineHeight={108 * k}
          letterSpacing={-2 * k}
          fill={fg(scene)}
          position={[0, -90 * k]}
          opacity={() => (scene.motion === "off" ? 1 : launchEase((local() - 0.2) / 0.5))}
        />,
      );
      root.add(
        <Txt
          text={scene.brand}
          fontFamily={scene.colors?.fontFamily ?? comp.theme.fontFamily}
          fontSize={30 * k}
          fontWeight={600}
          letterSpacing={4 * k}
          fill={fg(scene)}
          position={[0, 104 * k]}
          opacity={() => (scene.motion === "off" ? 1 : launchEase((local() - 0.6) / 0.45))}
        />,
      );
      root.add(
        <Rect
          layout
          padding={[16 * k, 26 * k]}
          radius={12 * k}
          fill={scene.colors?.accent ?? comp.theme.accent}
          position={[0, 190 * k]}
          opacity={() => (scene.motion === "off" ? 1 : launchEase((local() - 0.85) / 0.45))}
        >
          <Txt
            text={scene.cta}
            fontFamily="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
            fontSize={28 * k}
            fontWeight={600}
            fill={scene.colors?.canvas ?? comp.theme.canvas}
          />
        </Rect>,
      );
    }
    view.add(root);
  }
  yield* tween(windows.at(-1).endS, (v) => t(v * windows.at(-1).endS), linear);
});
