import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { PreviewEngine } from "../engine/preview";
import { useEngineTime } from "../hooks/usePreview";
import { type Derived, beatKindLabel, beatTitle, beatZooms, sampleScaleCurve } from "../lib/derive";
import { scaleX, tc } from "../lib/format";

type Props = {
  engine: PreviewEngine;
  derived: Derived;
  currentBeat: number;
  selectedBeat: number;
  onSelectBeat: (i: number) => void;
};

const H = 104;
const RULER_H = 22;
const CURVE_TOP = 14;
const CURVE_BOTTOM = H - RULER_H;
const CURVE_BAND = CURVE_BOTTOM - CURVE_TOP;

function useMeasure<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(e!.contentRect.width));
    ro.observe(ref.current);
    setW(ref.current.clientWidth);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

// Live playhead — isolated so only it re-renders at 60fps.
function Playhead({ engine, T, width }: { engine: PreviewEngine; T: number; width: number }) {
  const t = useEngineTime(engine);
  const x = T > 0 ? (t / T) * width : 0;
  return (
    <div className="playhead" style={{ transform: `translateX(${x}px)` }}>
      <span className="playhead__grip" />
    </div>
  );
}

export function Timeline({ engine, derived, currentBeat, selectedBeat, onSelectBeat }: Props) {
  const [ref, width] = useMeasure<HTMLDivElement>();
  const dragging = useRef(false);
  const T = derived.T;
  const x = useCallback((t: number) => (T > 0 ? (t / T) * width : 0), [T, width]);

  const seekToClientX = useCallback(
    (clientX: number) => {
      const el = ref.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const frac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      engine.seek(frac * T);
    },
    [engine, T, ref],
  );

  // --- scale-curve area path ---
  const norm = (s: number) =>
    derived.peakScale > derived.rest ? (s - derived.rest) / (derived.peakScale - derived.rest) : 0;
  const yOf = (s: number) => CURVE_BOTTOM - Math.max(0, Math.min(1, norm(s))) * CURVE_BAND;
  // resample only when the geometry (derived) or the width changes — not on every
  // playback beat-boundary re-render.
  const curve = useMemo(
    () =>
      width > 0 ? sampleScaleCurve(derived, Math.min(720, Math.max(120, Math.round(width)))) : [],
    [derived, width],
  );
  const areaPath = curve.length
    ? `M0,${CURVE_BOTTOM} ` +
      curve.map((p) => `L${x(p.t).toFixed(2)},${yOf(p.scale).toFixed(2)}`).join(" ") +
      ` L${width.toFixed(2)},${CURVE_BOTTOM} Z`
    : "";
  const linePath = curve.length
    ? "M" + curve.map((p) => `${x(p.t).toFixed(2)},${yOf(p.scale).toFixed(2)}`).join(" L")
    : "";

  // --- ruler seconds ---
  const seconds: number[] = [];
  for (let s = 0; s <= Math.floor(T); s++) seconds.push(s);

  return (
    <div className="timeline">
      <div className="timeline__legend">
        <span className="legend__swatch" /> zoom scale
        <span className="legend__rest">rest {scaleX(derived.rest)}</span>
        <span className="legend__peak">peak {scaleX(derived.peakScale)}</span>
      </div>

      <div
        className="timeline__track"
        ref={ref}
        style={{ height: H }}
        onPointerDown={(e) => {
          dragging.current = true;
          (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
          seekToClientX(e.clientX);
        }}
        onPointerMove={(e) => {
          if (dragging.current) seekToClientX(e.clientX);
        }}
        onPointerUp={() => {
          dragging.current = false;
        }}
        onPointerCancel={() => {
          dragging.current = false;
        }}
      >
        <svg className="timeline__svg" width={width} height={H} aria-hidden>
          <defs>
            <linearGradient id="zoomfill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="rgba(255,180,84,0.42)" />
              <stop offset="100%" stopColor="rgba(255,180,84,0.04)" />
            </linearGradient>
          </defs>
          {/* second gridlines */}
          {seconds.map((s) => (
            <line
              key={s}
              x1={x(s)}
              x2={x(s)}
              y1={CURVE_TOP - 4}
              y2={CURVE_BOTTOM}
              className="grid"
            />
          ))}
          {/* rest baseline */}
          <line x1={0} x2={width} y1={CURVE_BOTTOM} y2={CURVE_BOTTOM} className="baseline" />
          {/* zoom-scale area + outline */}
          {areaPath && <path d={areaPath} fill="url(#zoomfill)" />}
          {linePath && <path d={linePath} className="curveline" fill="none" />}
          {/* beat ticks */}
          {derived.comp.events.map((e, i) => (
            <line
              key={i}
              x1={x(e.tMs / 1000)}
              x2={x(e.tMs / 1000)}
              y1={CURVE_TOP - 4}
              y2={CURVE_BOTTOM + 4}
              className={`beat-tick${i === currentBeat ? " is-active" : ""}${i === selectedBeat ? " is-selected" : ""}${beatZooms(e, derived.rest) ? " zooms" : ""}`}
            />
          ))}
        </svg>

        {/* beat flags (HTML, so labels never distort) */}
        <div className="timeline__flags">
          {derived.comp.events.map((e, i) => (
            <button
              type="button"
              key={i}
              className={`flag${i === currentBeat ? " is-active" : ""}${i === selectedBeat ? " is-selected" : ""}`}
              style={{ left: x(e.tMs / 1000) }}
              onPointerDown={(ev) => ev.stopPropagation()}
              onClick={() => {
                engine.seek(e.tMs / 1000);
                onSelectBeat(i);
              }}
              title={`${beatTitle(e)} · ${tc(e.tMs / 1000)}s`}
            >
              <span className="flag__kind">{beatKindLabel(e)}</span>
              <span className="flag__title">{beatTitle(e)}</span>
            </button>
          ))}
        </div>

        <Playhead engine={engine} T={T} width={width} />

        {/* ruler labels */}
        <div className="timeline__ruler">
          {seconds.map((s) => (
            <span key={s} className="ruler__mark" style={{ left: x(s) }}>
              {s}s
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
