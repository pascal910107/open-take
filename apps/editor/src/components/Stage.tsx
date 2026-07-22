// The preview stage: live engine canvas + the zoom-region box overlay.
// Selecting a beat puts the engine in INSPECT mode (wide diagnostic frame) and
// shows the box for that beat's zoom: drag = re-aim (zoom.center), corner =
// tighten/loosen (zoom.scale). The box is the OUTPUT region the zoom will
// fill, so its aspect is locked to the output — resizing only changes scale.
import { useCallback, useRef } from "react";
import type { UseComposition } from "../hooks/useComposition";
import type { Pt, TakeComposition } from "../lib/compositor";
import { setBeatZoom } from "../lib/edit";
import { IcZoom } from "../ui/icons";

const SCALE_MAX = 2.4;

type DragState = { mode: "move" | "size"; x: number; y: number; center: Pt; scale: number };

export function Stage({
  canvasRef,
  videoRef,
  c,
  inspecting,
  comparing,
  pickingStart,
  onPickStart,
  onDeselect,
}: {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  c: UseComposition;
  inspecting: boolean;
  comparing: boolean;
  pickingStart: boolean;
  onPickStart: (p: Pt) => void;
  onDeselect: () => void;
}) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const drag = useRef<DragState | null>(null);

  const comp = c.comp;
  const sel = c.selectedBeat;
  const e = comp && sel >= 0 ? comp.events[sel] : undefined;
  const showBox = inspecting && comp && e?.zoom.enabled && c.derived;

  // video-px → screen fraction (engine draws at rest, centred, in inspect mode)
  const geom = useCallback(() => {
    const d = c.derived;
    const cc = c.comp;
    if (!d || !cc) return null;
    const { width: oW, height: oH } = cc.output;
    const { videoWidth: vW, videoHeight: vH } = cc.source;
    const rest = d.rest;
    const fx = (px: number) => (oW / 2 + rest * (px - vW / 2)) / oW;
    const fy = (py: number) => (oH / 2 + rest * (py - vH / 2)) / oH;
    return { oW, oH, vW, vH, rest, fx, fy };
  }, [c.derived, c.comp]);

  // the box rect (fractions of the frame) for the selected zoom
  let rect: { l: number; t: number; w: number; h: number } | null = null;
  if (showBox && comp && e) {
    const g = geom();
    if (g) {
      const wv = g.oW / e.zoom.scale;
      const hv = g.oH / e.zoom.scale;
      const l = g.fx(e.zoom.center.x - wv / 2);
      const t = g.fy(e.zoom.center.y - hv / 2);
      const r = g.fx(e.zoom.center.x + wv / 2);
      const b = g.fy(e.zoom.center.y + hv / 2);
      rect = { l, t, w: r - l, h: b - t };
    }
  }

  const onPointerDown = (ev: React.PointerEvent, mode: "move" | "size") => {
    if (!comp || sel < 0 || !e) return;
    drag.current = {
      mode,
      x: ev.clientX,
      y: ev.clientY,
      center: { ...e.zoom.center },
      scale: e.zoom.scale,
    };
    c.beginGesture();
    boxRef.current?.setPointerCapture(ev.pointerId);
    ev.stopPropagation();
    ev.preventDefault();
  };

  const onPointerMove = (ev: React.PointerEvent) => {
    const d = drag.current;
    const g = geom();
    const wrap = wrapRef.current;
    if (!d || !g || !wrap || sel < 0) return;
    const r = wrap.getBoundingClientRect();
    if (d.mode === "move") {
      const dx = ((ev.clientX - d.x) / r.width) * (g.oW / g.rest);
      const dy = ((ev.clientY - d.y) / r.height) * (g.oH / g.rest);
      const center = {
        x: Math.max(0, Math.min(g.vW, d.center.x + dx)),
        y: Math.max(0, Math.min(g.vH, d.center.y + dy)),
      };
      c.update((cc) => setBeatZoom(cc, sel, { center }), `box-move-${sel}`);
    } else {
      // corner drag changes the region width → scale (aspect locked)
      const dwFrac = (ev.clientX - d.x) / r.width;
      const wv0 = g.oW / d.scale;
      const wv = wv0 + (dwFrac * g.oW) / g.rest;
      const minScale = Math.max(g.rest + 0.02, 1.05);
      const scale = Math.max(minScale, Math.min(SCALE_MAX, g.oW / Math.max(1, wv)));
      c.update((cc) => setBeatZoom(cc, sel, { scale }), `box-size-${sel}`);
    }
  };

  const onStageClick = (ev: React.MouseEvent) => {
    const g = geom();
    const wrap = wrapRef.current;
    if (pickingStart && g && wrap) {
      const r = wrap.getBoundingClientRect();
      const fxc = (ev.clientX - r.left) / r.width;
      const fyc = (ev.clientY - r.top) / r.height;
      // invert the rest mapping back to video px
      const x = (fxc * g.oW - g.oW / 2) / g.rest + g.vW / 2;
      const y = (fyc * g.oH - g.oH / 2) / g.rest + g.vH / 2;
      onPickStart({
        x: Math.round(Math.max(0, Math.min(g.vW, x))),
        y: Math.round(Math.max(0, Math.min(g.vH, y))),
      });
      return;
    }
    if (inspecting) onDeselect();
  };

  return (
    <div className="stage">
      <div
        ref={wrapRef}
        className={`previewbox${inspecting ? " inspecting" : ""}${comparing ? " comparing" : ""}`}
        onClick={onStageClick}
        style={{
          // the CSS 16/9 is only the pre-load fallback — follow the real output
          ...(comp ? { aspectRatio: `${comp.output.width} / ${comp.output.height}` } : {}),
          ...(pickingStart ? { cursor: "crosshair" } : {}),
        }}
      >
        <canvas ref={canvasRef} />
        {/* the engine draws this hidden video onto the canvas */}
        <video ref={videoRef} muted playsInline preload="auto" crossOrigin="anonymous" />
        <div className="dimmer" />
        <span className="origbadge">ORIGINAL — 放開回到編輯版</span>
        {rect && (
          <div
            ref={boxRef}
            className="zbox"
            style={{
              left: `${rect.l * 100}%`,
              top: `${rect.t * 100}%`,
              width: `${rect.w * 100}%`,
              height: `${rect.h * 100}%`,
            }}
            onPointerDown={(ev) => onPointerDown(ev, "move")}
            onPointerMove={onPointerMove}
            onPointerUp={() => {
              drag.current = null;
            }}
            onClick={(ev) => ev.stopPropagation()}
          >
            <span className="tag">
              <IcZoom size={11} />
              <span>×{e ? e.zoom.scale.toFixed(1) : ""}</span>
            </span>
            <span className="hd" onPointerDown={(ev) => onPointerDown(ev, "size")} />
          </div>
        )}
      </div>
    </div>
  );
}

export type { TakeComposition };
