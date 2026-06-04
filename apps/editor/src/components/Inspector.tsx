import { useEffect, useState } from "react";
import type { PreviewEngine } from "../engine/preview";
import type { UseComposition } from "../hooks/useComposition";
import { beatKindLabel, beatTitle, beatZooms } from "../lib/derive";
import * as E from "../lib/edit";
import { ms, scaleX, tc } from "../lib/format";
import { ColorSwatch } from "./controls/ColorSwatch";
import { NumberScrubber } from "./controls/NumberScrubber";
import { Group, Row } from "./controls/Row";
import { Slider } from "./controls/Slider";
import { Toggle } from "./controls/Toggle";
import { Vec2 } from "./controls/Vec2";

type Props = {
  engine: PreviewEngine;
  c: UseComposition;
  /** playback beat (fallback target when nothing is explicitly selected). */
  currentBeat: number;
};

// The editable property panel over the cinematic layer. Every control writes
// through useComposition.update (immutable setters in lib/edit), which pushes to
// the engine live and re-runs validateComposition for the Save gate. Capture-
// locked fields (tMs/kind/text) are shown read-only with the ⦂ badge.
export function Inspector({ engine, c, currentBeat }: Props) {
  const comp = c.comp!;
  const derived = c.derived!;
  const [overlay, setOverlay] = useState(true);

  // edit target: an explicit selection wins; else follow the playhead's beat.
  const beat = c.selectedBeat >= 0 ? c.selectedBeat : currentBeat;
  const e = beat >= 0 ? comp.events[beat] : undefined;

  useEffect(() => {
    engine.setOverlay({ enabled: overlay, beatIndex: beat });
  }, [engine, overlay, beat]);

  const errors = c.errors.length;
  const warns = c.warns.length;
  const vW = comp.source.videoWidth;
  const vH = comp.source.videoHeight;
  const g = c.beginGesture;
  const up = c.update;

  // shadow as a directional light (angle + distance) over the stored offset
  const sh = comp.framing.shadow;
  const shDist = Math.round(Math.hypot(sh.offset.x, sh.offset.y));
  const shAng = Math.round((Math.atan2(sh.offset.y, sh.offset.x) * 180) / Math.PI);
  const setShadowDir = (angleDeg: number, dist: number) => {
    const th = (angleDeg * Math.PI) / 180;
    up(
      (x) =>
        E.setShadowOffset(x, {
          x: Math.round(dist * Math.cos(th)),
          y: Math.round(dist * Math.sin(th)),
        }),
      "shdir",
    );
  };
  const bgType = comp.framing.background.type ?? "gradient";

  return (
    <aside className="panel">
      <div className="panel__head">
        <h2>Inspector</h2>
        <Toggle checked={overlay} onChange={setOverlay} label="overlay" />
      </div>

      <div className="panel__scroll">
        {/* ---- selected beat ---- */}
        <Group title={e ? `Beat · ${beatTitle(e)}` : "Beat"}>
          {e ? (
            <>
              <Row label="kind" locked>
                <span className="ro">{beatKindLabel(e)}</span>
              </Row>
              <Row label="action @" locked>
                <span className="ro">{tc(e.tMs / 1000)}s</span>
              </Row>
              <Row label="zoom">
                <Toggle
                  checked={e.zoom.enabled}
                  onChange={(v) => up((x) => E.setBeatZoom(x, beat, { enabled: v }))}
                />
              </Row>
              {e.zoom.enabled && (
                <>
                  <Row label="scale" hint={`rest ${scaleX(derived.rest)}`}>
                    <span className="dual">
                      <Slider
                        value={e.zoom.scale}
                        min={derived.rest}
                        max={3}
                        step={0.01}
                        onCommitStart={g}
                        onChange={(v) =>
                          up((x) => E.setBeatZoom(x, beat, { scale: v }), `b${beat}.scale`)
                        }
                      />
                      <NumberScrubber
                        value={e.zoom.scale}
                        min={derived.rest}
                        step={0.01}
                        onCommitStart={g}
                        onChange={(v) =>
                          up((x) => E.setBeatZoom(x, beat, { scale: v }), `b${beat}.scale`)
                        }
                      />
                    </span>
                  </Row>
                  <Row label="level" hint="gentle presets — ~1.5× is the workhorse">
                    <span className="chips">
                      {[1.2, 1.4, 1.6, 1.8].map((L) => (
                        <button
                          key={L}
                          type="button"
                          className={`chip${Math.abs(e.zoom.scale - L) < 0.005 ? " is-active" : ""}`}
                          onClick={() => {
                            g();
                            up(
                              (x) => E.setBeatZoom(x, beat, { scale: Math.max(derived.rest, L) }),
                              `b${beat}.scale`,
                            );
                          }}
                        >
                          {L.toFixed(1)}×
                        </button>
                      ))}
                    </span>
                  </Row>
                  <Row label="center">
                    <span className="vec2-snap">
                      <Vec2
                        x={e.zoom.center.x}
                        y={e.zoom.center.y}
                        min={0}
                        maxX={vW}
                        maxY={vH}
                        onCommitStart={g}
                        onChangeX={(v) =>
                          up((x) => E.setBeatCenter(x, beat, { x: v }), `b${beat}.cx`)
                        }
                        onChangeY={(v) =>
                          up((x) => E.setBeatCenter(x, beat, { y: v }), `b${beat}.cy`)
                        }
                      />
                      {e.bbox && (
                        <button
                          type="button"
                          className="mini"
                          title="Snap to the element bbox center"
                          onClick={() => {
                            g();
                            up((x) =>
                              E.setBeatCenter(x, beat, {
                                x: e.bbox!.x + e.bbox!.w / 2,
                                y: e.bbox!.y + e.bbox!.h / 2,
                              }),
                            );
                          }}
                        >
                          snap
                        </button>
                      )}
                    </span>
                  </Row>
                  <Row
                    label="glide"
                    hint="slow drift while held (px/s) — adds life vs a static hold"
                  >
                    <Vec2
                      x={e.zoom.glide?.x ?? 0}
                      y={e.zoom.glide?.y ?? 0}
                      step={5}
                      onCommitStart={g}
                      onChangeX={(v) => up((x) => E.setBeatGlide(x, beat, { x: v }), `b${beat}.gx`)}
                      onChangeY={(v) => up((x) => E.setBeatGlide(x, beat, { y: v }), `b${beat}.gy`)}
                    />
                  </Row>
                </>
              )}
              <Row
                label="zoom-in @"
                hint={`suggested ${tc(Math.max(0, e.tMs - comp.cursor.zoomInMs) / 1000)}s`}
              >
                <NumberScrubber
                  value={e.zoom.inAtMs}
                  min={0}
                  max={e.tMs}
                  step={10}
                  unit="ms"
                  onCommitStart={g}
                  onChange={(v) => up((x) => E.setBeatZoom(x, beat, { inAtMs: v }), `b${beat}.in`)}
                />
              </Row>
              {e.durationMs != null && e.durationMs > 0 && (
                <Row label="duration" locked hint="ground-truth on-screen time — capture-locked">
                  <span className="ro">{ms(e.durationMs)}</span>
                </Row>
              )}
              {e.zoom.reason && <p className="reason">{e.zoom.reason}</p>}
            </>
          ) : (
            <p className="muted">
              Scrub to a beat or click a flag on the timeline to edit its zoom.
            </p>
          )}
        </Group>

        {/* ---- framing ---- */}
        <Group title="Framing">
          <Row label="inset" hint="video size at rest (backdrop padding)">
            <span className="dual">
              <Slider
                value={comp.framing.insetFrac}
                min={0.5}
                max={1}
                step={0.01}
                onCommitStart={g}
                onChange={(v) => up((x) => E.setFraming(x, { insetFrac: v }), "inset")}
              />
              <NumberScrubber
                value={comp.framing.insetFrac}
                min={0.5}
                max={1}
                step={0.01}
                onCommitStart={g}
                onChange={(v) => up((x) => E.setFraming(x, { insetFrac: v }), "inset")}
              />
            </span>
          </Row>
          <Row label="corner">
            <NumberScrubber
              value={comp.framing.cornerRadius}
              min={0}
              max={160}
              step={1}
              unit="px"
              onCommitStart={g}
              onChange={(v) => up((x) => E.setFraming(x, { cornerRadius: v }), "corner")}
            />
          </Row>
          <Row label="background">
            <span className="chips">
              {(["gradient", "solid"] as const).map((ty) => (
                <button
                  key={ty}
                  type="button"
                  className={`chip${bgType === ty ? " is-active" : ""}`}
                  onClick={() => {
                    g();
                    up((x) => E.setBackground(x, { type: ty }));
                  }}
                >
                  {ty}
                </button>
              ))}
            </span>
          </Row>
          <Row label={bgType === "solid" ? "color" : "bg from"}>
            <ColorSwatch
              value={comp.framing.background.from}
              onCommitStart={g}
              onChange={(v) => up((x) => E.setBackground(x, { from: v }), "bgfrom")}
            />
          </Row>
          {bgType !== "solid" && (
            <>
              <Row label="bg to">
                <ColorSwatch
                  value={comp.framing.background.to}
                  onCommitStart={g}
                  onChange={(v) => up((x) => E.setBackground(x, { to: v }), "bgto")}
                />
              </Row>
              <Row label="bg angle">
                <span className="dual">
                  <Slider
                    value={comp.framing.background.angle ?? 135}
                    min={0}
                    max={360}
                    step={1}
                    onCommitStart={g}
                    onChange={(v) => up((x) => E.setBackground(x, { angle: v }), "bgang")}
                  />
                  <NumberScrubber
                    value={comp.framing.background.angle ?? 135}
                    min={0}
                    max={360}
                    step={1}
                    unit="°"
                    onCommitStart={g}
                    onChange={(v) => up((x) => E.setBackground(x, { angle: v }), "bgang")}
                  />
                </span>
              </Row>
            </>
          )}
          <Row label="shadow">
            <ColorSwatch
              value={comp.framing.shadow.color}
              allowAlpha
              onCommitStart={g}
              onChange={(v) => up((x) => E.setShadow(x, { color: v }), "shcol")}
            />
          </Row>
          <Row label="shadow blur">
            <NumberScrubber
              value={comp.framing.shadow.blur}
              min={0}
              max={200}
              step={1}
              unit="px"
              onCommitStart={g}
              onChange={(v) => up((x) => E.setShadow(x, { blur: v }), "shblur")}
            />
          </Row>
          <Row label="shadow angle" hint="light direction (°) — derives the offset">
            <NumberScrubber
              value={shAng}
              step={5}
              unit="°"
              onCommitStart={g}
              onChange={(v) => setShadowDir(v, shDist)}
            />
          </Row>
          <Row label="shadow distance">
            <NumberScrubber
              value={shDist}
              min={0}
              max={200}
              step={1}
              unit="px"
              onCommitStart={g}
              onChange={(v) => setShadowDir(shAng, v)}
            />
          </Row>
        </Group>

        {/* ---- cursor feel ---- */}
        <Group title="Cursor feel" defaultOpen={false}>
          <Row label="travel speed" hint="widths/sec — the dominant 'silky' lever">
            <span className="dual">
              <Slider
                value={comp.cursor.travelWidthsPerSec}
                min={0}
                max={1}
                step={0.01}
                onCommitStart={g}
                onChange={(v) => up((x) => E.setCursor(x, { travelWidthsPerSec: v }), "twps")}
              />
              <NumberScrubber
                value={comp.cursor.travelWidthsPerSec}
                min={0}
                max={1}
                step={0.01}
                onCommitStart={g}
                onChange={(v) => up((x) => E.setCursor(x, { travelWidthsPerSec: v }), "twps")}
              />
            </span>
          </Row>
          <Row label="travel min">
            <NumberScrubber
              value={comp.cursor.travelMinMs}
              min={0}
              step={10}
              unit="ms"
              onCommitStart={g}
              onChange={(v) => up((x) => E.setCursor(x, { travelMinMs: v }), "tmin")}
            />
          </Row>
          <Row label="travel max">
            <NumberScrubber
              value={comp.cursor.travelMaxMs}
              min={0}
              step={10}
              unit="ms"
              onCommitStart={g}
              onChange={(v) => up((x) => E.setCursor(x, { travelMaxMs: v }), "tmax")}
            />
          </Row>
          <Row label="cursor scale">
            <NumberScrubber
              value={comp.cursor.scale}
              min={0.5}
              max={5}
              step={0.1}
              unit="×"
              onCommitStart={g}
              onChange={(v) => up((x) => E.setCursor(x, { scale: v }), "cscale")}
            />
          </Row>
          <Row label="arc">
            <Slider
              value={comp.cursor.arcFrac}
              min={0}
              max={0.5}
              step={0.01}
              onCommitStart={g}
              onChange={(v) => up((x) => E.setCursor(x, { arcFrac: v }), "arc")}
            />
          </Row>
          <Row label="ripple">
            <NumberScrubber
              value={comp.cursor.rippleMs}
              min={0}
              step={10}
              unit="ms"
              onCommitStart={g}
              onChange={(v) => up((x) => E.setCursor(x, { rippleMs: v }), "ripple")}
            />
          </Row>
          <Row label="zoom-in ramp">
            <NumberScrubber
              value={comp.cursor.zoomInMs}
              min={0}
              step={10}
              unit="ms"
              onCommitStart={g}
              onChange={(v) => up((x) => E.setCursor(x, { zoomInMs: v }), "zin")}
            />
          </Row>
          <Row label="zoom-out ramp">
            <NumberScrubber
              value={comp.cursor.zoomOutMs}
              min={0}
              step={10}
              unit="ms"
              onCommitStart={g}
              onChange={(v) => up((x) => E.setCursor(x, { zoomOutMs: v }), "zout")}
            />
          </Row>
          <Row label="hold">
            <NumberScrubber
              value={comp.cursor.holdMs}
              min={0}
              step={10}
              unit="ms"
              onCommitStart={g}
              onChange={(v) => up((x) => E.setCursor(x, { holdMs: v }), "hold")}
            />
          </Row>
          <Row label="drag lag" hint="cursor delay so its tip rides the captured ink">
            <NumberScrubber
              value={comp.cursor.dragLagMs}
              min={0}
              step={5}
              unit="ms"
              onCommitStart={g}
              onChange={(v) => up((x) => E.setCursor(x, { dragLagMs: v }), "draglag")}
            />
          </Row>
          <Row label="zoom easing" hint="spring = silky settle; off = bezier">
            <Toggle
              checked={comp.cursor.zoomSpring != null}
              onChange={(v) => up((x) => E.setCursor(x, { zoomSpring: v ? 0.1 : undefined }))}
              label="spring"
            />
          </Row>
          {comp.cursor.zoomSpring != null && (
            <Row label="bounce" hint="0 = soft (no overshoot) · higher = snappier landing">
              <span className="dual">
                <Slider
                  value={comp.cursor.zoomSpring}
                  min={0}
                  max={0.5}
                  step={0.01}
                  onCommitStart={g}
                  onChange={(v) => up((x) => E.setCursor(x, { zoomSpring: v }), "bounce")}
                />
                <NumberScrubber
                  value={comp.cursor.zoomSpring}
                  min={0}
                  max={0.5}
                  step={0.01}
                  onCommitStart={g}
                  onChange={(v) => up((x) => E.setCursor(x, { zoomSpring: v }), "bounce")}
                />
              </span>
            </Row>
          )}
        </Group>

        {/* ---- composition ---- */}
        <Group title="Composition" defaultOpen={false}>
          <Row label="duration" hint="total timeline incl. the zoom-out tail">
            <NumberScrubber
              value={comp.durationMs}
              min={0}
              step={100}
              unit="ms"
              onCommitStart={g}
              onChange={(v) => up((x) => E.setDuration(x, v), "dur")}
            />
          </Row>
          <Row label="cursor start">
            <Vec2
              x={comp.start.x}
              y={comp.start.y}
              step={1}
              onCommitStart={g}
              onChangeX={(v) => up((x) => E.setStart(x, { x: v }), "stx")}
              onChangeY={(v) => up((x) => E.setStart(x, { y: v }), "sty")}
            />
          </Row>
          <Row label="output" locked>
            <span className="ro">
              {comp.output.width}×{comp.output.height} · {comp.output.fps}fps
            </span>
          </Row>
          <Row label="beats" locked>
            <span className="ro">{comp.events.length}</span>
          </Row>
        </Group>
      </div>

      {/* ---- validate verdict (the Save gate, visible from day one) ---- */}
      <div className="panel__validate">
        <div className="panel__label">
          validate
          <span className={`vbadge ${errors ? "is-error" : warns ? "is-warn" : "is-ok"}`}>
            {errors ? `${errors} error${errors > 1 ? "s" : ""}` : warns ? `${warns} warn` : "ok"}
          </span>
        </div>
        {c.issues.length === 0 ? (
          <p className="muted">passes the export gate.</p>
        ) : (
          <ul className="issues">
            {c.issues.map((i, n) => (
              <li key={n} className={`issue is-${i.severity}`}>
                <button
                  type="button"
                  className="issue__path"
                  onClick={() => selectIssueBeat(i.path, c)}
                >
                  <code>{i.path}</code>
                </button>
                <span>{i.message}</span>
                {i.fix && <span className="issue__fix">{i.fix}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}

// Jump the inspector selection to the beat an issue references (events[N].…).
function selectIssueBeat(path: string, c: UseComposition) {
  const m = /^events\[(\d+)\]/.exec(path);
  if (m) c.selectBeat(Number(m[1]));
}
