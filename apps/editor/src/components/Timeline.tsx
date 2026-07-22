// Transport + ruler + filmstrip + zoom-block track + playhead. The timeline is
// the "everyone gets it" surface: the filmstrip is the video, the iris blocks
// are the zooms, dashed ghosts are beats a zoom could be added to.
import { useEffect, useMemo, useRef, useState } from "react";
import type { PreviewEngine } from "../engine/preview";
import type { TakeComposition } from "../lib/compositor";
import type { Derived } from "../lib/derive";
import { IcNext, IcPause, IcPlay, IcPrev, IcZoom } from "../ui/icons";

const THUMBS = 18;

function fmt(t: number): string {
  const m = Math.floor(t / 60);
  const s = t % 60;
  return `${m}:${s < 10 ? "0" : ""}${s.toFixed(1)}`;
}

/** Seek a detached <video> through N evenly-spaced times and rasterise tiny
 *  thumbnails for the filmstrip. */
function useFilmstrip(videoSrc: string | null, durS: number): string[] {
  const [thumbs, setThumbs] = useState<string[]>([]);
  useEffect(() => {
    if (!videoSrc) return;
    let cancelled = false;
    const v = document.createElement("video");
    v.muted = true;
    v.preload = "auto";
    v.crossOrigin = "anonymous";
    v.src = videoSrc;
    const out: string[] = [];
    const cv = document.createElement("canvas");
    const grab = (i: number) => {
      if (cancelled) return;
      if (i >= THUMBS) {
        setThumbs(out);
        v.removeAttribute("src");
        v.load();
        return;
      }
      const t = ((i + 0.5) / THUMBS) * Math.max(0.1, Math.min(durS, v.duration || durS));
      const onSeeked = () => {
        v.removeEventListener("seeked", onSeeked);
        if (cancelled) return;
        const w = 120;
        const h = Math.round((w * v.videoHeight) / Math.max(1, v.videoWidth));
        cv.width = w;
        cv.height = h;
        cv.getContext("2d")?.drawImage(v, 0, 0, w, h);
        try {
          out.push(cv.toDataURL("image/jpeg", 0.6));
        } catch {
          /* tainted canvas — skip thumbs */
        }
        grab(i + 1);
      };
      v.addEventListener("seeked", onSeeked);
      v.currentTime = Math.min(t, (v.duration || durS) - 0.05);
    };
    v.addEventListener("loadedmetadata", () => grab(0), { once: true });
    return () => {
      cancelled = true;
      v.removeAttribute("src");
      v.load();
    };
  }, [videoSrc, durS]);
  return thumbs;
}

export function Timeline({
  engine,
  comp,
  derived,
  videoSrc,
  isPlaying,
  selectedBeat,
  onSelectBeat,
  onEnableZoom,
}: {
  engine: PreviewEngine;
  comp: TakeComposition;
  derived: Derived;
  videoSrc: string | null;
  isPlaying: boolean;
  selectedBeat: number;
  onSelectBeat: (i: number) => void;
  onEnableZoom: (i: number) => void;
}) {
  const totalMs = derived.T * 1000;
  const [t, setT] = useState(engine.currentTime);
  useEffect(() => engine.on("time", setT), [engine]);

  const thumbs = useFilmstrip(videoSrc, comp.source.viewport ? derived.T : derived.T);

  const tlRef = useRef<HTMLDivElement | null>(null);
  const scrub = (clientX: number) => {
    const r = tlRef.current?.getBoundingClientRect();
    if (!r) return;
    const f = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    engine.seek((f * totalMs) / 1000);
  };

  const blocks = useMemo(() => {
    const hold = comp.cursor.holdMs;
    return comp.events.map((e, i) => {
      const end = e.tMs + (e.durationMs ?? 0) + hold;
      const next = comp.events[i + 1];
      const t1 = e.zoom.enabled ? Math.min(next ? next.zoom.inAtMs : end, end) : 0;
      return e.zoom.enabled
        ? {
            i,
            ghost: false,
            t0: e.zoom.inAtMs,
            t1: Math.max(t1, e.zoom.inAtMs + 500),
            scale: e.zoom.scale,
          }
        : {
            i,
            ghost: true,
            t0: Math.max(0, e.tMs - 600),
            t1: e.tMs + (e.durationMs ?? 600),
            scale: 0,
          };
    });
  }, [comp]);

  const beatsSorted = comp.events.map((e) => e.tMs / 1000);
  const seekPrev = () => {
    const cur = engine.currentTime;
    const prev = [...beatsSorted].reverse().find((b) => b < cur - 0.2);
    engine.seek(prev ?? 0);
  };
  const seekNext = () => {
    const cur = engine.currentTime;
    const next = beatsSorted.find((b) => b > cur + 0.2);
    engine.seek(next ?? derived.T);
  };

  const ticks = [];
  for (let s = 0; s <= Math.floor(derived.T); s++) ticks.push(s);

  return (
    <div className="bottom">
      <div className="transport">
        <span className="time mono">
          <b>{fmt(t)}</b> / {fmt(derived.T)}
        </span>
        <button type="button" className="tbtn" onClick={seekPrev} aria-label="上一個 beat">
          <IcPrev />
        </button>
        <button
          type="button"
          className="tbtn play"
          onClick={() => engine.toggle()}
          aria-label="播放/暫停"
        >
          {isPlaying ? <IcPause /> : <IcPlay />}
        </button>
        <button type="button" className="tbtn" onClick={seekNext} aria-label="下一個 beat">
          <IcNext />
        </button>
      </div>

      <div className="ruler">
        {ticks
          .filter((s) => s % 2 === 0)
          .map((s) => (
            <span key={s} className="mono" style={{ left: `${((s * 1000) / totalMs) * 100}%` }}>
              {fmt(s).replace(".0", "")}
            </span>
          ))}
        {ticks.map((s) => (
          <i key={s} style={{ left: `${((s * 1000) / totalMs) * 100}%` }} />
        ))}
      </div>

      <div className="tl" ref={tlRef}>
        <div
          className="filmstrip"
          onPointerDown={(e) => {
            scrub(e.clientX);
            const move = (ev: PointerEvent) => scrub(ev.clientX);
            const up = () => {
              window.removeEventListener("pointermove", move);
              window.removeEventListener("pointerup", up);
            };
            window.addEventListener("pointermove", move);
            window.addEventListener("pointerup", up);
          }}
        >
          {thumbs.map((src, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static evenly-spaced strip
            <img key={i} src={src} alt="" />
          ))}
        </div>
        <div className="ztrack">
          {blocks.map((b) => (
            <button
              type="button"
              key={b.i}
              className={`zb${b.ghost ? " ghost" : ""}${b.i === selectedBeat && !b.ghost ? " on" : ""}`}
              style={{
                left: `${(b.t0 / totalMs) * 100}%`,
                width: `${(Math.max(600, b.t1 - b.t0) / totalMs) * 100}%`,
              }}
              title={
                b.ghost ? `在「${beatTitle(comp, b.i)}」加入 Zoom` : `Beat ${b.i + 1} · ×${b.scale}`
              }
              onClick={() => (b.ghost ? onEnableZoom(b.i) : onSelectBeat(b.i))}
            >
              {b.ghost ? (
                "＋ Zoom"
              ) : (
                <>
                  <IcZoom size={11} />
                  {`×${+b.scale.toFixed(1)}`}
                </>
              )}
            </button>
          ))}
        </div>
        <div
          className="playhead"
          style={{ left: `${(t / derived.T) * 100}%` }}
          onPointerDown={(e) => {
            (e.target as HTMLElement).setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            if ((e.buttons & 1) === 1) scrub(e.clientX);
          }}
        />
      </div>
      <div className="tlhint">
        <IcZoom size={12} />
        藍色是 Zoom 區塊 — 點擊調整；虛線位置可加入 Zoom
      </div>
    </div>
  );
}

function beatTitle(comp: TakeComposition, i: number): string {
  const e = comp.events[i];
  if (!e) return "";
  return e.label ?? (e.kind === "type" && e.text ? `"${e.text}"` : e.kind);
}
