// Generic revideo scene: renders ANY TakeComposition. Compiled by
// revideo's vite at render time (NOT typechecked by tsc — excluded).
// renderTake writes ./.composition.json before each render.
import { makeScene2D, Rect, Video, Line, Circle, Node, Gradient } from "@revideo/2d";
import { createSignal, tween, linear } from "@revideo/core";
import {
  buildStageKeyframes,
  buildLegs,
  cursorPos,
  isDragging,
  keyvalN,
  keyvalP,
  clampCenter,
  smoother,
  cubicBezier,
} from "../math";
import comp from "./.composition.json";

const vW = comp.source.videoWidth, vH = comp.source.videoHeight;
const oW = comp.output.width, oH = comp.output.height;
const stage = buildStageKeyframes(comp);
const legs = buildLegs(comp);

// video-px -> stage-local coords (stage local origin = video centre)
const lx = (px) => px - vW / 2;
const ly = (py) => py - vH / 2;

// arrow cursor (tip at local 0,0), scaled
const S = comp.cursor.scale;
const CURSOR = [[0, 0], [0, 17], [4.5, 13], [7.5, 19.5], [10, 18.3], [7, 11.7], [12, 11.7]].map(
  ([x, y]) => [x * S, y * S],
);

export default makeScene2D("take", function* (view) {
  const t = createSignal(0);

  // zoom/pan stage easing (scale + center in unison); falls back to smootherstep
  const zoomEase = comp.cursor.zoomEase ? cubicBezier(...comp.cursor.zoomEase) : smoother;
  const scaleAt = () => keyvalN(t(), stage.z, zoomEase);
  const centerAt = () => clampCenter(keyvalP(t(), stage.c, zoomEase), scaleAt(), vW, vH, oW, oH);

  // static gradient backdrop
  view.add(
    <Rect
      width={oW}
      height={oH}
      fill={
        new Gradient({
          type: "linear",
          from: [-oW / 2, -oH / 2],
          to: [oW / 2, oH / 2],
          stops: [
            { offset: 0, color: comp.framing.background.from },
            { offset: 1, color: comp.framing.background.to },
          ],
        })
      }
    />,
  );

  // stage: scales/pans together; clamped so no backdrop leaks when zoomed
  view.add(
    <Node
      position={() => {
        const s = scaleAt(), c = centerAt();
        return [-(c.x - vW / 2) * s, -(c.y - vH / 2) * s];
      }}
      scale={() => [scaleAt(), scaleAt()]}
    >
      {/* framing rendered IN revideo: rounded mask + drop shadow */}
      <Rect
        width={vW}
        height={vH}
        radius={comp.framing.cornerRadius}
        clip
        fill={"#0a0e1c"}
        shadowColor={comp.framing.shadow.color}
        shadowBlur={comp.framing.shadow.blur}
        shadowOffset={[comp.framing.shadow.offset.x, comp.framing.shadow.offset.y]}
      >
        <Video src={comp.source.videoUrl} width={vW} height={vH} play={true} />
      </Rect>

      {/* click ripples — pointer-landing beats only (scroll/press have no
          spatial click point, so they get no ripple) */}
      {comp.events.filter((e) => e.kind !== "scroll" && e.kind !== "press").map((e) => {
        const ms = comp.cursor.rippleMs / 1000;
        const prog = () => {
          const dt = t() - e.tMs / 1000;
          return dt >= 0 && dt <= ms ? dt / ms : -1;
        };
        return (
          <Circle
            position={[lx(e.point.x), ly(e.point.y)]}
            size={() => {
              const p = prog();
              return p < 0 ? 0 : (12 + 60 * smoother(p)) * 2;
            }}
            stroke={"white"}
            lineWidth={4}
            opacity={() => {
              const p = prog();
              return p < 0 ? 0 : (150 * (1 - p)) / 255;
            }}
          />
        );
      })}

      {/* synthetic cursor on ground-truth waypoints */}
      <Node
        position={() => {
          const c = cursorPos(t(), legs, comp);
          return [lx(c.x), ly(c.y)];
        }}
      >
        {/* pressed-state ring while a drag is mid-stroke (button held) */}
        <Circle
          size={() => (isDragging(t(), legs) ? 30 : 0)}
          fill={"rgba(255,255,255,0.16)"}
          stroke={"white"}
          lineWidth={2}
        />
        <Line points={CURSOR.map(([x, y]) => [x + 2.5, y + 2.5])} closed fill={"rgba(0,0,0,0.35)"} />
        <Line points={CURSOR} closed fill={"rgb(20,20,24)"} stroke={"white"} lineWidth={2} />
      </Node>
    </Node>,
  );

  yield* tween(stage.T, (v) => t(v * stage.T), linear);
});
