// The seven layered settings panes behind the icon rail. Plain words, few
// controls per pane, advanced knobs behind 進階 — never a dense numeric wall.
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
      <p className="desc">每一段 Zoom 對應影片中的一個動作。點下方時間軸的藍色區塊來編輯。</p>
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
              <Row label="深度" value={`${e.zoom.scale.toFixed(1)}×`}>
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
              <Row label="進入時機" value={`−${((e.tMs - e.zoom.inAtMs) / 1000).toFixed(1)}s`}>
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
                  title={e.bbox ? "把畫面框對準這個動作的元素" : "這個動作沒有元素框"}
                  onClick={() => {
                    const b = e.bbox;
                    if (!b) return;
                    c.update((cc) =>
                      setBeatZoom(cc, sel, { center: { x: b.x + b.w / 2, y: b.y + b.h / 2 } }),
                    );
                  }}
                >
                  <IcTarget size={13} /> 貼齊元素
                </MiniBtn>
                <span className="hint" style={{ marginTop: 0 }}>
                  或直接拖畫面上的框
                </span>
              </div>
              <Adv>
                <Row label="漂移 X" value={`${e.zoom.glide?.x ?? 0}px/s`}>
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
                <Row label="漂移 Y" value={`${e.zoom.glide?.y ?? 0}px/s`}>
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
                <p className="hint">漂移＝Zoom 停留時鏡頭緩慢滑動（reference recorder 的 glide）。</p>
              </Adv>
            </>
          )}
        </Card>
      ) : (
        <Card>
          <p className="hint" style={{ marginTop: 0 }}>
            尚未選取 — 點時間軸上的<b>藍色區塊</b>編輯該段 Zoom，或把虛線區塊按成 Zoom。
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
      <p className="desc">影片後方的背景。Look 一鍵套用整套（顏色＋圓角＋陰影）。</p>
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
        <h3>自訂</h3>
        <OptionCards
          options={[
            { key: "gradient", label: "漸層", icon: <IcGradient /> },
            { key: "solid", label: "單色", icon: <IcSolid /> },
          ]}
          value={type}
          onChange={(k) => c.update((cc) => setBackground(cc, { type: k as "gradient" | "solid" }))}
        />
        <Row label="顏色">
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
          <Row label="角度" value={`${bg.angle ?? 135}°`}>
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
      <p className="desc">螢幕畫面在背景上的呈現：留邊、圓角與陰影。</p>
      <Card>
        <Row label="留邊" value={`${pad}%`}>
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
        <Row label="圓角" value={`${fr.cornerRadius}`}>
          <Slider
            min={0}
            max={48}
            value={fr.cornerRadius}
            onGestureStart={c.beginGesture}
            onChange={(v) => c.update((cc) => setFraming(cc, { cornerRadius: v }), "corner")}
          />
        </Row>
      </Card>
      <Card head="陰影">
        <Row label="強度" value={`${Math.round(alpha * 100)}%`}>
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
        <Row label="柔度" value={`${fr.shadow.blur}`}>
          <Slider
            min={0}
            max={120}
            value={fr.shadow.blur}
            onGestureStart={c.beginGesture}
            onChange={(v) => c.update((cc) => setShadow(cc, { blur: v }), "shblur")}
          />
        </Row>
        <Row label="方向" value={`${(angle + 360) % 360}°`}>
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
      <p className="desc">合成游標的樣子與移動手感。</p>
      <Card>
        <Row label="大小" value={`${cur.scale.toFixed(1)}×`}>
          <Slider
            min={1}
            max={3}
            step={0.1}
            value={cur.scale}
            onGestureStart={c.beginGesture}
            onChange={(v) => c.update((cc) => setCursor(cc, { scale: v }), "cscale")}
          />
        </Row>
        <Row label="移動速度" value={cur.travelWidthsPerSec.toFixed(2)}>
          <Slider
            min={0.2}
            max={0.6}
            step={0.01}
            value={cur.travelWidthsPerSec}
            onGestureStart={c.beginGesture}
            onChange={(v) => c.update((cc) => setCursor(cc, { travelWidthsPerSec: v }), "cspeed")}
          />
        </Row>
        <Row label="路徑彎度" value={`${Math.round(cur.arcFrac * 100)}%`}>
          <Slider
            min={0}
            max={20}
            value={Math.round(cur.arcFrac * 100)}
            onGestureStart={c.beginGesture}
            onChange={(v) => c.update((cc) => setCursor(cc, { arcFrac: v / 100 }), "carc")}
          />
        </Row>
        <Row label="點擊漣漪">
          <Toggle
            on={cur.rippleMs > 0}
            onChange={(on) => c.update((cc) => setCursor(cc, { rippleMs: on ? 450 : 0 }))}
          />
        </Row>
      </Card>
      <Adv>
        <Row label="最短移動" value={`${(cur.travelMinMs / 1000).toFixed(1)}s`}>
          <Slider
            min={100}
            max={600}
            step={10}
            value={cur.travelMinMs}
            onGestureStart={c.beginGesture}
            onChange={(v) => c.update((cc) => setCursor(cc, { travelMinMs: v }), "cmin")}
          />
        </Row>
        <Row label="最長移動" value={`${(cur.travelMaxMs / 1000).toFixed(2)}s`}>
          <Slider
            min={400}
            max={1400}
            step={10}
            value={cur.travelMaxMs}
            onGestureStart={c.beginGesture}
            onChange={(v) => c.update((cc) => setCursor(cc, { travelMaxMs: v }), "cmax")}
          />
        </Row>
        <Row label="筆跡延遲" value={`${cur.dragLagMs}ms`}>
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
      <p className="desc">鏡頭的節奏與質感。選一種節奏，或展開微調每個時長。</p>
      <div className="sect">
        <h3>節奏</h3>
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
            <Row label="強度" value={mb.shutter.toFixed(1)}>
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
            <Row label="品質">
              <OptionCards
                compact
                options={[
                  { key: "3", label: "快" },
                  { key: "6", label: "平衡" },
                  { key: "9", label: "最細" },
                ]}
                value={["3", "6", "9"].includes(String(mb.samples)) ? String(mb.samples) : null}
                onChange={(k) => c.update((cc) => setMotionBlur(cc, { ...mb, samples: Number(k) }))}
              />
            </Row>
            {!["3", "6", "9"].includes(String(mb.samples)) && (
              <p className="hint">目前為自訂品質（{mb.samples}×）— 點選任一檔位會覆蓋。</p>
            )}
            <p className="hint">品質越高輸出越慢（渲染張數 = fps × 品質）。預覽不受影響。</p>
          </>
        )}
      </Card>
      <Adv label="微調時長">
        <Row label="放大 進入" value={`${(cur.zoomInMs / 1000).toFixed(2)}s`}>
          <Slider
            min={300}
            max={1400}
            step={20}
            value={cur.zoomInMs}
            onGestureStart={c.beginGesture}
            onChange={(v) => c.update((cc) => setCursorRebased(cc, { zoomInMs: v }), "zin")}
          />
        </Row>
        <Row label="放大 退出" value={`${(cur.zoomOutMs / 1000).toFixed(2)}s`}>
          <Slider
            min={300}
            max={1400}
            step={20}
            value={cur.zoomOutMs}
            onGestureStart={c.beginGesture}
            onChange={(v) => c.update((cc) => setCursor(cc, { zoomOutMs: v }), "zout")}
          />
        </Row>
        <Row label="停留" value={`${(cur.holdMs / 1000).toFixed(1)}s`}>
          <Slider
            min={400}
            max={2400}
            step={50}
            value={cur.holdMs}
            onGestureStart={c.beginGesture}
            onChange={(v) => c.update((cc) => setCursor(cc, { holdMs: v }), "hold")}
          />
        </Row>
        <Row label="彈性" value={(cur.zoomSpring ?? 0).toFixed(2)}>
          <Slider
            min={0}
            max={0.3}
            step={0.01}
            value={cur.zoomSpring ?? 0}
            onGestureStart={c.beginGesture}
            onChange={(v) =>
              c.update((cc) => setCursor(cc, { zoomSpring: v === 0 ? undefined : v }), "spring")
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
      <p className="desc">整支影片的長度與開場。</p>
      <Card>
        <Row label="結尾停留" value={`${(tail / 1000).toFixed(1)}s`}>
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
            <IcCursor size={13} /> {pickingStart ? "點畫面設定起點…" : "設定游標起點"}
          </MiniBtn>
        </div>
      </Card>
      <Card>
        <p className="hint" style={{ marginTop: 0 }}>
          輸出 {comp.output.width}×{comp.output.height} · {comp.output.fps}fps ·{" "}
          {comp.events.length} beats
          <br />
          總長 {(comp.durationMs / 1000).toFixed(1)}s
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
        setSent("已送給 agent — 它會處理並告訴你成本");
      } catch {
        await navigator.clipboard.writeText(t.trim()).catch(() => {});
        setSent("橋接不可用 — 已複製，貼給你的 agent");
      }
    } else {
      await navigator.clipboard.writeText(t.trim()).catch(() => {});
      setSent("已複製 — 貼給你的 agent");
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
        介面改不動的 — 換順序、改點擊內容、重新錄 — 用說的，agent 會處理並告訴你成本。
      </p>
      <div className="agent-input">
        <input
          value={text}
          placeholder="例如「把 beat 4、5 對調」"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // ignore the Enter that commits an IME composition (Chrome/Firefox:
            // isComposing; Safari fires the commit keydown with keyCode 229)
            if (e.key === "Enter" && !e.nativeEvent.isComposing && e.keyCode !== 229)
              void send(text);
          }}
        />
        <MiniBtn onClick={() => void send(text)}>送出</MiniBtn>
      </div>
      <div className="chiplist">
        {["開頭再快一點", "結尾太長", "換一個結尾畫面"].map((q) => (
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
