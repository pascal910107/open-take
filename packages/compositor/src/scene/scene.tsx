// Generic revideo scene: renders ANY TakeComposition. Compiled by
// revideo's vite at render time (NOT typechecked by tsc — excluded).
// renderTake writes ./.composition.json before each render.
import { makeScene2D, Rect, Video, Line, Circle, Node, Gradient, Txt } from "@revideo/2d";
import { createSignal, tween, linear } from "@revideo/core";
import {
  stageCamera,
  buildLegs,
  cursorPos,
  isDragging,
  gradientEndpoints,
  smoother,
  carryWindow,
  ghostCardLines,
} from "../math";
import comp from "./.composition.json";

const vW = comp.source.videoWidth,
  vH = comp.source.videoHeight;
const oW = comp.output.width,
  oH = comp.output.height;
const cam = stageCamera(comp);
const legs = buildLegs(comp);
const rest = cam.rest;

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

  // The camera: ONE eased viewport rect (centre + size in lockstep, targets
  // pre-clamped at build) — see math.ts stageCamera. Mirrors the editor preview.
  const scaleAt = () => cam.at(t()).scale;
  const centerAt = () => cam.at(t()).center;

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
          spatial click point; a look touches nothing, and a ripple at a point
          the cursor never visited would invent a click that did not happen).
          A dropFiles ripples at its DROP point on RELEASE — not at the
          off-content carry entry — and stays on even when the ghost card is
          disabled (parity with the editor preview). */}
        {comp.events
          .filter((e) => e.kind !== "scroll" && e.kind !== "press" && e.kind !== "look")
          .map((e, index) => {
            const ms = comp.cursor.rippleMs / 1000;
            const at =
              e.kind === "dropFiles"
                ? { t0: carryWindow(e, comp).t1, p: e.to ?? e.point }
                : { t0: e.tMs / 1000, p: e.point };
            const prog = () => {
              const dt = t() - at.t0;
              return dt >= 0 && dt <= ms ? dt / ms : -1;
            };
            return (
              <Circle
                key={`${e.kind}-${e.tMs}-${index}`}
                position={[lx(at.p.x), ly(at.p.y)]}
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

        {/* file ghost card — a macOS-style translucent file card riding the
          cursor through a dropFiles carry, popping/fading on release. Drawn
          UNDER the cursor node so the pointer stays on top. Mirrored in the
          editor preview (preview.ts) — keep cosmetics in step. */}
        {comp.events
          .filter((e) => e.kind === "dropFiles" && e.ghostCard?.enabled !== false)
          .map((e, index) => {
            const gk = vW / 1920; // card is authored for a 1920-wide video
            const gc = e.ghostCard ?? {};
            const off = gc.offset ?? { x: 26 * gk, y: 30 * gk };
            const win = carryWindow(e, comp);
            const releaseS = (gc.releaseMs ?? 280) / 1000;
            const fadeS = 0.15;
            const lines = ghostCardLines(e.files ?? []);
            const vis = () => {
              const tt = t();
              if (tt < win.t0 - fadeS || tt > win.t1 + releaseS) return 0;
              if (tt < win.t0) return (tt - (win.t0 - fadeS)) / fadeS;
              if (tt <= win.t1) return 1;
              return 1 - (tt - win.t1) / releaseS;
            };
            // the release pop: a slight grow as the card lets go of the file
            const pop = () => {
              const tt = t();
              const z =
                tt <= win.t1 ? 1 : 1 + 0.08 * smoother(Math.min(1, (tt - win.t1) / releaseS));
              return [z, z];
            };
            return (
              <Node key={`ghostCard-${e.tMs}-${index}`}>
                <Node
                  position={() => {
                    const c = cursorPos(t(), legs, comp);
                    return [lx(c.x) + off.x, ly(c.y) + off.y];
                  }}
                  opacity={vis}
                  scale={pop}
                >
                  <Rect
                    layout
                    direction={"column"}
                    alignItems={"start"}
                    padding={[11 * gk, 16 * gk]}
                    gap={3 * gk}
                    radius={10 * gk}
                    offset={[-1, -1]}
                    fill={"rgba(24,24,27,0.86)"}
                    stroke={"rgba(255,255,255,0.22)"}
                    lineWidth={1}
                    shadowColor={"rgba(0,0,0,0.45)"}
                    shadowBlur={26 * gk}
                    shadowOffset={[0, 8 * gk]}
                  >
                    <Txt
                      text={lines.title}
                      fontFamily={"ui-monospace, 'SF Mono', Menlo, Consolas, monospace"}
                      fontSize={21 * gk}
                      fontWeight={600}
                      fill={"rgba(255,255,255,0.95)"}
                    />
                    {lines.meta ? (
                      <Txt
                        text={lines.meta}
                        fontFamily={"system-ui, -apple-system, 'Segoe UI', 'Noto Sans', sans-serif"}
                        fontSize={16 * gk}
                        fontWeight={500}
                        fill={"rgba(255,255,255,0.55)"}
                      />
                    ) : null}
                  </Rect>
                </Node>
              </Node>
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

  // Review decoration (badges / watermark / variant label) — SCREEN space,
  // added AFTER the camera node so it draws on top and never rides the zoom.
  // Only present on review copies and A/B reels (composition.review), never on
  // the postable master. Text renders in Chrome, so no ffmpeg font filters.
  const review = comp.review;
  if (review) {
    const k = oH / 1080; // scale UI with output size
    const FONT = "system-ui, -apple-system, 'Segoe UI', 'Noto Sans', sans-serif";
    const pad = 36 * k;
    if (review.watermark) {
      view.add(
        <Txt
          text={review.watermark}
          position={[oW / 2 - pad, -oH / 2 + pad]}
          offset={[1, -1]}
          fontFamily={FONT}
          fontSize={24 * k}
          letterSpacing={4 * k}
          fontWeight={600}
          fill={"rgba(255,255,255,0.34)"}
        />,
      );
    }
    const pill = (text, opacity, big) => (
      <Rect
        layout
        padding={[10 * k, 16 * k]}
        radius={8 * k}
        fill={"rgba(0,0,0,0.55)"}
        position={[-oW / 2 + pad, oH / 2 - pad]}
        offset={[-1, 1]}
        opacity={opacity}
      >
        <Txt
          text={text}
          fontFamily={FONT}
          fontSize={(big ? 30 : 25) * k}
          fontWeight={500}
          fill={"rgba(255,255,255,0.94)"}
        />
      </Rect>
    );
    for (const b of review.badges ?? []) {
      // 120ms fade at each end so badge swaps don't pop
      const op = () => {
        const ms = t() * 1000;
        if (ms < b.fromMs || ms >= b.toMs) return 0;
        const inF = Math.min(1, (ms - b.fromMs) / 120);
        const outF = Math.min(1, (b.toMs - ms) / 120);
        return Math.min(inF, outF);
      };
      view.add(pill(b.text, op, false));
    }
    if (review.label) view.add(pill(review.label, 1, true));
  }

  // Viewer-facing captions — SCREEN space like the review decor, but a
  // first-class composition field drawn on EVERY render including the master.
  // Bottom-CENTER (the subtitle slot), so review badges (bottom-left) never
  // collide with it. Footage shows what happened; the caption says what it
  // means — the difference between a demo a stranger can follow and "the
  // screen moves around". 160ms fades: soft under motion blur, never a pop.
  //
  // Anchored INSIDE the framed card (above the at-rest backdrop band), never
  // on the frame's edge: a pill straddling the card/backdrop seam has the
  // zooming card boundary sweep THROUGH it, which reads as the caption itself
  // moving — the field complaint that motivated this anchor. Sized for the
  // couch, not the badge rail: 34px @1080 with a 600 weight (CJK at 500 reads
  // thin), a hairline border and a soft drop shadow so it sits ON the video
  // as a produced element instead of a debug overlay.
  // CINEMA-style, not boxed: film subtitles earn their look from big
  // confident type sitting on a soft bottom scrim — the pill/box treatment
  // (two attempts, both rejected in the field) reads as a debug overlay no
  // matter how it is dressed. The scrim is constant while captions exist
  // (a pulsing scrim is worse than none) and the type carries a TIGHT
  // shadow: at 1080p the footage is 4K-downsampled (supersampled-sharp)
  // while overlays render native, so overlays must lean on stroke weight
  // and contrast — a wide blur reads as smear next to that footage.
  const k = oH / 1080;
  const FONT = "system-ui, -apple-system, 'Segoe UI', 'Noto Sans', sans-serif";
  if (comp.captions?.length) {
    const cardBottom = (oH / 2) * comp.framing.insetFrac;
    const scrimH = 190 * k;
    view.add(
      <Rect
        width={oW}
        height={scrimH}
        position={[0, oH / 2]}
        offset={[0, 1]}
        fill={
          new Gradient({
            type: "linear",
            from: { x: 0, y: -scrimH / 2 },
            to: { x: 0, y: scrimH / 2 },
            stops: [
              { offset: 0, color: "rgba(0,0,0,0)" },
              { offset: 1, color: "rgba(0,0,0,0.55)" },
            ],
          })
        }
      />,
    );
    for (const c of comp.captions) {
      const op = () => {
        const ms = t() * 1000;
        if (ms < c.fromMs || ms >= c.toMs) return 0;
        const inF = Math.min(1, (ms - c.fromMs) / 160);
        const outF = Math.min(1, (c.toMs - ms) / 160);
        return Math.min(inF, outF);
      };
      view.add(
        <Txt
          text={c.text}
          fontFamily={FONT}
          fontSize={36 * k}
          fontWeight={600}
          letterSpacing={0.8 * k}
          fill={"rgba(255,255,255,0.98)"}
          shadowColor={"rgba(0,0,0,0.9)"}
          shadowBlur={6 * k}
          shadowOffset={[0, 2 * k]}
          maxWidth={oW * 0.82}
          textWrap={true}
          textAlign={"center"}
          position={[0, cardBottom - 26 * k]}
          offset={[0, 1]}
          opacity={op}
        />,
      );
    }
  }

  // Opening title card — full-frame scrim + the app/thesis in big type over
  // the establishing hold, gone by untilMs. The cheapest "produced, not
  // captured" signal; typographic and deterministic by design (no generated
  // imagery — brand-safe, language follows the author, deletable field).
  if (comp.titleCard?.title) {
    const tc = comp.titleCard;
    const untilMs = tc.untilMs ?? (comp.startMs ?? 0) + 1800;
    const tcOp = () => {
      const ms = t() * 1000;
      if (ms >= untilMs) return 0;
      return Math.min(1, (untilMs - ms) / 300);
    };
    view.add(
      <Rect width={oW} height={oH} position={[0, 0]} fill={"rgba(6,7,14,0.55)"} opacity={tcOp} />,
    );
    view.add(
      <Txt
        text={tc.title}
        fontFamily={FONT}
        fontSize={72 * k}
        fontWeight={800}
        letterSpacing={2 * k}
        fill={"rgba(255,255,255,0.98)"}
        shadowColor={"rgba(0,0,0,0.8)"}
        shadowBlur={10 * k}
        shadowOffset={[0, 3 * k]}
        position={[0, tc.subtitle ? -26 * k : 0]}
        opacity={tcOp}
      />,
    );
    if (tc.subtitle)
      view.add(
        <Txt
          text={tc.subtitle}
          fontFamily={FONT}
          fontSize={30 * k}
          fontWeight={500}
          letterSpacing={1 * k}
          fill={"rgba(255,255,255,0.78)"}
          shadowColor={"rgba(0,0,0,0.8)"}
          shadowBlur={8 * k}
          shadowOffset={[0, 2 * k]}
          position={[0, 40 * k]}
          opacity={tcOp}
        />,
      );
  }

  yield* tween(cam.T, (v) => t(v * cam.T), linear);
});
