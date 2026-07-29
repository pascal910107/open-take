// The seven layered settings panes behind the icon rail. Plain words, few
// controls per pane, advanced knobs behind Advanced — never a dense numeric wall.
import { useState } from "react";
import type { UseComposition } from "../hooks/useComposition";
import { sendNote } from "../lib/bridge";
import {
  DEFAULT_MOTION_BLUR,
  LOOKS,
  MOTION,
  type Pt,
  lookName,
  motionName,
} from "../lib/compositor";
import {
  applyLook,
  setBackground,
  setBeatGlide,
  setBeatZoom,
  setCursor,
  setCursorRebased,
  setDuration,
  setFraming,
  setMotionBlur,
  setShadow,
  setShadowOffset,
} from "../lib/edit";
import { Adv, Card, MiniBtn, OptionCards, Row, Slider, Thumbs, Toggle } from "../ui/controls";
import {
  IcAgent,
  IcBg,
  IcCalm,
  IcClip,
  IcCursor,
  IcFast,
  IcFrame,
  IcGradient,
  IcMotion,
  IcNatural,
  IcSolid,
  IcTarget,
  IcZoom,
} from "../ui/icons";

type P = { c: UseComposition };

// --- Zoom --------------------------------------------------------------------

export function ZoomPane({ c }: P) {
  const comp = c.comp;
  const sel = c.selectedBeat;
  const e = comp && sel >= 0 ? comp.events[sel] : undefined;
  // an enabled zoom must stay >= the rest scale or the validator refuses it
  const scaleMin = Math.max(1.1, (c.derived?.rest ?? 0.92) + 0.02);
  const title = e ? (e.label ?? (e.kind === "type" && e.text ? `"${e.text}"` : e.kind)) : "";

  return (
    <div className="pane">
      <h2>
        <IcZoom /> Zoom
      </h2>
      <p className="desc">
        Each zoom belongs to one action in the video. Click a blue block in the timeline below to
        edit it.
      </p>
      {comp && e ? (
        <Card
          head={`Beat ${sel + 1} · ${title}`}
          headRight={
            <Toggle
              on={e.zoom.enabled}
              onChange={(on) => c.update((cc) => setBeatZoom(cc, sel, { enabled: on }))}
            />
          }
        >
          {e.zoom.enabled && (
            <>
              <Row label="Depth" value={`${e.zoom.scale.toFixed(1)}×`}>
                <Slider
                  min={scaleMin}
                  max={2.4}
                  step={0.05}
                  value={Math.max(scaleMin, e.zoom.scale)}
                  onGestureStart={c.beginGesture}
                  onChange={(v) =>
                    c.update((cc) => setBeatZoom(cc, sel, { scale: v }), `depth-${sel}`)
                  }
                />
              </Row>
              <Row label="Lead-in" value={`−${((e.tMs - e.zoom.inAtMs) / 1000).toFixed(1)}s`}>
                <Slider
                  min={0}
                  max={1600}
                  step={20}
                  value={e.tMs - e.zoom.inAtMs}
                  onGestureStart={c.beginGesture}
                  onChange={(v) =>
                    c.update(
                      (cc) => setBeatZoom(cc, sel, { inAtMs: Math.max(0, e.tMs - v) }),
                      "inat",
                    )
                  }
                />
              </Row>
              <div className="row" style={{ justifyContent: "flex-start" }}>
                <MiniBtn
                  disabled={!e.bbox}
                  title={
                    e.bbox
                      ? "Line the frame up with this action's element"
                      : "This action has no element box"
                  }
                  onClick={() => {
                    const b = e.bbox;
                    if (!b) return;
                    c.update((cc) =>
                      setBeatZoom(cc, sel, { center: { x: b.x + b.w / 2, y: b.y + b.h / 2 } }),
                    );
                  }}
                >
                  <IcTarget size={13} /> Snap to element
                </MiniBtn>
                <span className="hint" style={{ marginTop: 0 }}>
                  or just drag the box on the stage
                </span>
              </div>
              <Adv>
                <Row label="Glide X" value={`${e.zoom.glide?.x ?? 0}px/s`}>
                  <Slider
                    min={-60}
                    max={60}
                    value={e.zoom.glide?.x ?? 0}
                    onGestureStart={c.beginGesture}
                    onChange={(v) =>
                      c.update((cc) => setBeatGlide(cc, sel, { x: v }), `glidex-${sel}`)
                    }
                  />
                </Row>
                <Row label="Glide Y" value={`${e.zoom.glide?.y ?? 0}px/s`}>
                  <Slider
                    min={-60}
                    max={60}
                    value={e.zoom.glide?.y ?? 0}
                    onGestureStart={c.beginGesture}
                    onChange={(v) =>
                      c.update((cc) => setBeatGlide(cc, sel, { y: v }), `glidey-${sel}`)
                    }
                  />
                </Row>
                <p className="hint">Glide = the camera drifts slowly while the zoom holds.</p>
              </Adv>
            </>
          )}
        </Card>
      ) : (
        <Card>
          <p className="hint" style={{ marginTop: 0 }}>
            Nothing selected — click a <b>blue block</b> in the timeline to edit its zoom, or click
            a dashed one to add a zoom there.
          </p>
        </Card>
      )}
    </div>
  );
}

// --- Background --------------------------------------------------------------

export function BgPane({ c }: P) {
  const comp = c.comp;
  if (!comp) return null;
  const bg = comp.framing.background;
  const active = lookName(comp.framing);
  const type = bg.type === "solid" ? "solid" : "gradient";

  return (
    <div className="pane">
      <h2>
        <IcBg /> Background
      </h2>
      <p className="desc">
        The backdrop behind the video. A Look applies the whole set at once (colour + corners +
        shadow).
      </p>
      <div className="sect">
        <h3>Look</h3>
        <Thumbs
          items={Object.entries(LOOKS).map(([key, l]) => ({
            key,
            css:
              l.background.type === "solid"
                ? l.background.from
                : `linear-gradient(135deg, ${l.background.from}, ${l.background.to})`,
          }))}
          value={active}
          onChange={(k) => c.update((cc) => applyLook(cc, LOOKS[k]!))}
        />
      </div>
      <div className="sect">
        <h3>Custom</h3>
        <OptionCards
          options={[
            { key: "gradient", label: "Gradient", icon: <IcGradient /> },
            { key: "solid", label: "Solid", icon: <IcSolid /> },
          ]}
          value={type}
          onChange={(k) => c.update((cc) => setBackground(cc, { type: k as "gradient" | "solid" }))}
        />
        <Row label="Colour">
          <input
            type="color"
            value={toHex(bg.from)}
            onChange={(e) =>
              c.update((cc) => setBackground(cc, { from: e.target.value }), "bgfrom")
            }
          />
          {type === "gradient" && (
            <input
              type="color"
              value={toHex(bg.to)}
              onChange={(e) => c.update((cc) => setBackground(cc, { to: e.target.value }), "bgto")}
            />
          )}
        </Row>
        {type === "gradient" && (
          <Row label="Angle" value={`${bg.angle ?? 135}°`}>
            <Slider
              min={0}
              max={360}
              value={bg.angle ?? 135}
              onGestureStart={c.beginGesture}
              onChange={(v) => c.update((cc) => setBackground(cc, { angle: v }), "bgangle")}
            />
          </Row>
        )}
      </div>
    </div>
  );
}

const toHex = (s: string): string => (/^#[0-9a-f]{6}$/i.test(s) ? s : "#1e1b3a");

// --- Frame -------------------------------------------------------------------

export function FramePane({ c }: P) {
  const comp = c.comp;
  if (!comp) return null;
  const fr = comp.framing;
  const pad = Math.round((1 - fr.insetFrac) * 100);
  const alpha = shadowAlpha(fr.shadow.color);
  const dist = Math.round(Math.hypot(fr.shadow.offset.x, fr.shadow.offset.y)) || 28;
  const angle = Math.round((Math.atan2(fr.shadow.offset.x, fr.shadow.offset.y) * 180) / Math.PI);

  return (
    <div className="pane">
      <h2>
        <IcFrame /> Frame
      </h2>
      <p className="desc">How the screen sits on the background: padding, corners and shadow.</p>
      <Card>
        <Row label="Padding" value={`${pad}%`}>
          <Slider
            min={0}
            max={30}
            value={pad}
            onGestureStart={c.beginGesture}
            onChange={(v) =>
              c.update((cc) => {
                const next = setFraming(cc, { insetFrac: 1 - v / 100 });
                // rest moved — keep every enabled zoom at/above the new floor
                const { width: oW, height: oH } = next.output;
                const { videoWidth: vW, videoHeight: vH } = next.source;
                const rest = next.framing.insetFrac * Math.min(oW / vW, oH / vH);
                const events = next.events.map((ev) =>
                  ev.zoom.enabled && ev.zoom.scale < rest + 0.02
                    ? { ...ev, zoom: { ...ev.zoom, scale: rest + 0.02 } }
                    : ev,
                );
                return { ...next, events };
              }, "pad")
            }
          />
        </Row>
        <Row label="Corners" value={`${fr.cornerRadius}`}>
          <Slider
            min={0}
            max={48}
            value={fr.cornerRadius}
            onGestureStart={c.beginGesture}
            onChange={(v) => c.update((cc) => setFraming(cc, { cornerRadius: v }), "corner")}
          />
        </Row>
      </Card>
      <Card head="Shadow">
        <Row label="Strength" value={`${Math.round(alpha * 100)}%`}>
          <Slider
            min={0}
            max={100}
            value={Math.round(alpha * 100)}
            onGestureStart={c.beginGesture}
            onChange={(v) =>
              c.update(
                (cc) => setShadow(cc, { color: `rgba(0,0,0,${(v / 100).toFixed(2)})` }),
                "shalpha",
              )
            }
          />
        </Row>
        <Row label="Softness" value={`${fr.shadow.blur}`}>
          <Slider
            min={0}
            max={120}
            value={fr.shadow.blur}
            onGestureStart={c.beginGesture}
            onChange={(v) => c.update((cc) => setShadow(cc, { blur: v }), "shblur")}
          />
        </Row>
        <Row label="Direction" value={`${(angle + 360) % 360}°`}>
          <Slider
            min={0}
            max={360}
            value={(angle + 360) % 360}
            onGestureStart={c.beginGesture}
            onChange={(v) => {
              const rad = (v * Math.PI) / 180;
              c.update(
                (cc) =>
                  setShadowOffset(cc, {
                    x: Math.round(Math.sin(rad) * dist),
                    y: Math.round(Math.cos(rad) * dist),
                  }),
                "shdir",
              );
            }}
          />
        </Row>
      </Card>
    </div>
  );
}

function shadowAlpha(color: string): number {
  const m = /rgba?\([^)]*,\s*([\d.]+)\)/.exec(color);
  return m ? Number(m[1]) : 0.55;
}

// --- Cursor ------------------------------------------------------------------

export function CursorPane({ c }: P) {
  const comp = c.comp;
  if (!comp) return null;
  const cur = comp.cursor;
  return (
    <div className="pane">
      <h2>
        <IcCursor /> Cursor
      </h2>
      <p className="desc">How the synthetic cursor looks and how it moves.</p>
      <Card>
        <Row label="Size" value={`${cur.scale.toFixed(1)}×`}>
          <Slider
            min={1}
            max={3}
            step={0.1}
            value={cur.scale}
            onGestureStart={c.beginGesture}
            onChange={(v) => c.update((cc) => setCursor(cc, { scale: v }), "cscale")}
          />
        </Row>
        <Row label="Travel speed" value={cur.travelWidthsPerSec.toFixed(2)}>
          <Slider
            min={0.2}
            max={0.6}
            step={0.01}
            value={cur.travelWidthsPerSec}
            onGestureStart={c.beginGesture}
            onChange={(v) => c.update((cc) => setCursor(cc, { travelWidthsPerSec: v }), "cspeed")}
          />
        </Row>
        <Row label="Path curve" value={`${Math.round(cur.arcFrac * 100)}%`}>
          <Slider
            min={0}
            max={20}
            value={Math.round(cur.arcFrac * 100)}
            onGestureStart={c.beginGesture}
            onChange={(v) => c.update((cc) => setCursor(cc, { arcFrac: v / 100 }), "carc")}
          />
        </Row>
        <Row label="Click ripple">
          <Toggle
            on={cur.rippleMs > 0}
            onChange={(on) => c.update((cc) => setCursor(cc, { rippleMs: on ? 450 : 0 }))}
          />
        </Row>
      </Card>
      <Adv>
        <Row label="Min travel" value={`${(cur.travelMinMs / 1000).toFixed(1)}s`}>
          <Slider
            min={100}
            max={600}
            step={10}
            value={cur.travelMinMs}
            onGestureStart={c.beginGesture}
            onChange={(v) => c.update((cc) => setCursor(cc, { travelMinMs: v }), "cmin")}
          />
        </Row>
        <Row label="Max travel" value={`${(cur.travelMaxMs / 1000).toFixed(2)}s`}>
          <Slider
            min={400}
            max={1400}
            step={10}
            value={cur.travelMaxMs}
            onGestureStart={c.beginGesture}
            onChange={(v) => c.update((cc) => setCursor(cc, { travelMaxMs: v }), "cmax")}
          />
        </Row>
        <Row label="Drag lag" value={`${cur.dragLagMs}ms`}>
          <Slider
            min={0}
            max={400}
            step={5}
            value={cur.dragLagMs}
            onGestureStart={c.beginGesture}
            onChange={(v) => c.update((cc) => setCursor(cc, { dragLagMs: v }), "clag")}
          />
        </Row>
      </Adv>
    </div>
  );
}

// --- Motion ------------------------------------------------------------------

export function MotionPane({ c }: P) {
  const comp = c.comp;
  if (!comp) return null;
  const cur = comp.cursor;
  const mb = comp.motionBlur;
  const blurOn = !!mb && mb.samples > 1 && mb.shutter > 0;
  const pace = motionName(cur);
  const paceKey =
    pace === "calm" ? "calm" : pace === "brisk" ? "brisk" : pace === "natural" ? "natural" : null;

  return (
    <div className="pane">
      <h2>
        <IcMotion /> Motion
      </h2>
      <p className="desc">
        The camera's pace and texture. Pick a pace, or expand to fine-tune each duration.
      </p>
      <div className="sect">
        <h3>Pace</h3>
        <OptionCards
          options={[
            { key: "calm", label: "Calm", icon: <IcCalm /> },
            { key: "natural", label: "Natural", icon: <IcNatural /> },
            { key: "brisk", label: "Fast", icon: <IcFast /> },
          ]}
          value={paceKey}
          onChange={(k) => c.update((cc) => setCursorRebased(cc, MOTION[k]!))}
        />
      </div>
      <Card
        head="Motion blur"
        headRight={
          <Toggle
            on={blurOn}
            onChange={(on) =>
              c.update((cc) => setMotionBlur(cc, on ? DEFAULT_MOTION_BLUR : undefined))
            }
          />
        }
      >
        {blurOn && mb && (
          <>
            <Row label="Strength" value={mb.shutter.toFixed(1)}>
              <Slider
                min={0.1}
                max={1}
                step={0.05}
                value={mb.shutter}
                onGestureStart={c.beginGesture}
                onChange={(v) =>
                  c.update((cc) => setMotionBlur(cc, { ...mb, shutter: v }), "shutter")
                }
              />
            </Row>
            <Row label="Quality">
              <OptionCards
                compact
                options={[
                  { key: "3", label: "Fast" },
                  { key: "6", label: "Balanced" },
                  { key: "9", label: "Finest" },
                ]}
                value={["3", "6", "9"].includes(String(mb.samples)) ? String(mb.samples) : null}
                onChange={(k) => c.update((cc) => setMotionBlur(cc, { ...mb, samples: Number(k) }))}
              />
            </Row>
            {!["3", "6", "9"].includes(String(mb.samples)) && (
              <p className="hint">
                Custom quality right now ({mb.samples}×) — picking a preset overrides it.
              </p>
            )}
            <p className="hint">
              Higher quality means a slower export (frames rendered = fps × quality). The preview is
              unaffected.
            </p>
          </>
        )}
      </Card>
      <Adv label="Fine-tune durations">
        <Row label="Zoom in" value={`${(cur.zoomInMs / 1000).toFixed(2)}s`}>
          <Slider
            min={300}
            max={1400}
            step={20}
            value={cur.zoomInMs}
            onGestureStart={c.beginGesture}
            onChange={(v) => c.update((cc) => setCursorRebased(cc, { zoomInMs: v }), "zin")}
          />
        </Row>
        <Row label="Zoom out" value={`${(cur.zoomOutMs / 1000).toFixed(2)}s`}>
          <Slider
            min={300}
            max={1800}
            step={20}
            value={cur.zoomOutMs}
            onGestureStart={c.beginGesture}
            onChange={(v) => c.update((cc) => setCursor(cc, { zoomOutMs: v }), "zout")}
          />
        </Row>
        <Row label="Hold" value={`${(cur.holdMs / 1000).toFixed(1)}s`}>
          <Slider
            min={400}
            max={2400}
            step={50}
            value={cur.holdMs}
            onGestureStart={c.beginGesture}
            onChange={(v) => c.update((cc) => setCursor(cc, { holdMs: v }), "hold")}
          />
        </Row>
        {/* 0 = the default critically-damped spring. An older composition may carry
            a zoomEase (bezier), which wins while no spring is set — show that
            honestly; moving the slider (or applying a pace preset) switches to the
            spring. */}
        <Row
          label="Springiness"
          value={
            cur.zoomSpring == null && cur.zoomEase
              ? "bezier (legacy)"
              : (cur.zoomSpring ?? 0).toFixed(2)
          }
        >
          <Slider
            min={0}
            max={0.3}
            step={0.01}
            value={cur.zoomSpring ?? 0}
            onGestureStart={c.beginGesture}
            onChange={(v) =>
              c.update(
                (cc) =>
                  setCursor(cc, {
                    // moving the slider commits to the spring family: an explicit
                    // 0 wins over a legacy zoomEase; with no zoomEase, 0 clears
                    // back to the (identical) default spring.
                    zoomSpring: v === 0 ? (cc.cursor.zoomEase ? 0 : undefined) : v,
                  }),
                "spring",
              )
            }
          />
        </Row>
      </Adv>
    </div>
  );
}

// --- Clip --------------------------------------------------------------------

export function ClipPane({
  c,
  pickingStart,
  onArmPickStart,
}: P & { pickingStart: boolean; onArmPickStart: () => void }) {
  const comp = c.comp;
  if (!comp) return null;
  const lastEnd = comp.events.reduce((m, e) => Math.max(m, e.tMs + (e.durationMs ?? 0)), 0);
  const base = lastEnd + comp.cursor.holdMs + comp.cursor.zoomOutMs;
  const tail = Math.max(0, comp.durationMs - base);

  return (
    <div className="pane">
      <h2>
        <IcClip /> Clip
      </h2>
      <p className="desc">The whole video's length and where it opens.</p>
      <Card>
        <Row label="Tail hold" value={`${(tail / 1000).toFixed(1)}s`}>
          <Slider
            min={0}
            max={3000}
            step={100}
            value={Math.min(3000, tail)}
            onGestureStart={c.beginGesture}
            onChange={(v) => c.update((cc) => setDuration(cc, base + v), "tail")}
          />
        </Row>
        <div className="row" style={{ justifyContent: "flex-start" }}>
          <MiniBtn onClick={onArmPickStart}>
            <IcCursor size={13} /> {pickingStart ? "Click the stage…" : "Set cursor start"}
          </MiniBtn>
        </div>
      </Card>
      <Card>
        <p className="hint" style={{ marginTop: 0 }}>
          Output {comp.output.width}×{comp.output.height} · {comp.output.fps}fps ·{" "}
          {comp.events.length} beats
          <br />
          Total {(comp.durationMs / 1000).toFixed(1)}s
        </p>
      </Card>
    </div>
  );
}

// --- Agent -------------------------------------------------------------------

export function AgentPane({ bridge }: { bridge: boolean }) {
  const [text, setText] = useState("");
  const [sent, setSent] = useState<string | null>(null);

  const send = async (t: string) => {
    if (!t.trim()) return;
    if (bridge) {
      try {
        await sendNote(t.trim());
        setSent("Sent to the agent — it will handle this and tell you the cost");
      } catch {
        await navigator.clipboard.writeText(t.trim()).catch(() => {});
        setSent("Bridge unavailable — copied instead, paste it to your agent");
      }
    } else {
      await navigator.clipboard.writeText(t.trim()).catch(() => {});
      setSent("Copied — paste it to your agent");
    }
    setText("");
    setTimeout(() => setSent(null), 4000);
  };

  return (
    <div className="pane">
      <h2>
        <IcAgent /> Agent
      </h2>
      <p className="desc">
        Anything this UI can't change — beat order, what gets clicked, a re-shoot — just say it. The
        agent handles it and tells you the cost. Write in any language.
      </p>
      <div className="agent-input">
        <input
          value={text}
          placeholder={'e.g. "swap beats 4 and 5"'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // ignore the Enter that commits an IME composition (Chrome/Firefox:
            // isComposing; Safari fires the commit keydown with keyCode 229)
            if (e.key === "Enter" && !e.nativeEvent.isComposing && e.keyCode !== 229)
              void send(text);
          }}
        />
        <MiniBtn onClick={() => void send(text)}>Send</MiniBtn>
      </div>
      <div className="chiplist">
        {["Faster opening", "Tail is too long", "Different closing shot"].map((q) => (
          <button type="button" key={q} onClick={() => void send(q)}>
            {q}
          </button>
        ))}
      </div>
      {sent && <p className="sent-note">{sent} ✓</p>}
    </div>
  );
}

export type { Pt };
