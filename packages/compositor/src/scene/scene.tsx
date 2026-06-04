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
  stageEasing,
  panEasing,
  gradientEndpoints,
  restStageScale,
} from "../math";
import comp from "./.composition.json";

const vW = comp.source.videoWidth,
  vH = comp.source.videoHeight;
const oW = comp.output.width,
  oH = comp.output.height;
const stage = buildStageKeyframes(comp);
const legs = buildLegs(comp);
const rest = restStageScale(vW, vH, oW, oH, comp.framing.insetFrac);

// video-px -> stage-local coords (stage local origin = video centre)
const lx = (px) => px - vW / 2;
const ly = (py) => py - vH / 2;

// arrow cursor (tip at local 0,0), scaled
const S = comp.cursor.scale;
const CURSOR = [
  [0, 0],
  [0, 17],
  [4.5, 13],
  [7.5, 19.5],
  [10, 18.3],
  [7, 11.7],
  [12, 11.7],
].map(([x, y]) => [x * S, y * S]);

export default makeScene2D("take", function* (view) {
  const t = createSignal(0);

  // zoom/pan stage easing (scale + center in unison): spring → bezier → smoother
  const scaleEase = stageEasing(comp.cursor); // zoom-IN: spring allowed
  const panEase = panEasing(comp.cursor); // zoom-OUT scale + centre: smooth bezier
  // spring in / bezier out (smooth settle); Math.max(rest,…) is a floor. Mirrors derive.ts.
  const scaleAt = () => Math.max(rest, keyvalN(t(), stage.z, scaleEase, panEase));
  const centerAt = () => clampCenter(keyvalP(t(), stage.c, panEase), scaleAt(), vW, vH, oW, oH);

  // Composition camera: ONE camera zooms the WHOLE
  // composition (backdrop + the inset framed screen) together. At rest the
  // camera shows the full composition (backdrop margin around the inset screen);
  // a zoom crops into the screen (so it fills the frame — backdrop cropped out).
  // Because the backdrop scales/pans WITH everything (it's inside the camera, not
  // a static layer the video overfills), zoom-OUT is one uniform motion field —
  // the backdrop slides back in at the edges with no static-edge *reveal*, which
  // is what removes the old two-stage zoom-out stutter.
  //
  // Geometry: cameraNode scale = s/rest, position = -(c-vW/2)·s. Inside it the
  // screen group is drawn at scale `rest` (the inset), so the video's NET scale
  // is (s/rest)·rest = s and its NET position is s·(px−c) — identical to before,
  // i.e. the video/cursor render exactly as they did; only the backdrop moved
  // inside the camera. The backdrop Rect fills the composition (oW×oH); at rest
  // (s=rest ⇒ camera scale 1, centred) it covers the output exactly.
  const fr = comp.framing;
  const bg = comp.framing.background;
  const ge = gradientEndpoints(bg.angle, oW, oH);
  view.add(
    <Node
      position={() => {
        const s = scaleAt(),
          c = centerAt();
        return [-(c.x - vW / 2) * s, -(c.y - vH / 2) * s];
      }}
      scale={() => {
        const z = scaleAt() / rest;
        return [z, z];
      }}
    >
      {/* backdrop — part of the composition, zoomed by the camera */}
      <Rect
        width={oW}
        height={oH}
        fill={
          bg.type === "solid"
            ? bg.from
            : new Gradient({
                type: "linear",
                from: [ge.x0 - oW / 2, ge.y0 - oH / 2],
                to: [ge.x1 - oW / 2, ge.y1 - oH / 2],
                stops: [
                  { offset: 0, color: bg.from },
                  { offset: 1, color: bg.to },
                ],
              })
        }
      />

      {/* screen group: the inset framed recording (scale `rest`), so the video
          fills the composition's content area minus the backdrop margin. */}
      <Node scale={[rest, rest]}>
        {/* framing rendered IN revideo: rounded mask + drop shadow */}
        <Rect
          width={vW}
          height={vH}
          radius={fr.cornerRadius}
          clip
          fill={"#0a0e1c"}
          shadowColor={fr.shadow.color}
          shadowBlur={fr.shadow.blur}
          shadowOffset={[fr.shadow.offset.x, fr.shadow.offset.y]}
        >
          <Video src={comp.source.videoUrl} width={vW} height={vH} play={true} />
        </Rect>

        {/* click ripples — pointer-landing beats only (scroll/press have no
          spatial click point, so they get no ripple) */}
        {comp.events
          .filter((e) => e.kind !== "scroll" && e.kind !== "press")
          .map((e) => {
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
          <Line
            points={CURSOR.map(([x, y]) => [x + 2.5, y + 2.5])}
            closed
            fill={"rgba(0,0,0,0.35)"}
          />
          <Line points={CURSOR} closed fill={"rgb(20,20,24)"} stroke={"white"} lineWidth={2} />
        </Node>
      </Node>
    </Node>,
  );

  yield* tween(stage.T, (v) => t(v * stage.T), linear);
});
