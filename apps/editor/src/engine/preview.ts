// PreviewEngine — the live WYSIWYG core. Plays the capture <video> and draws
// the cinematic transform onto a <canvas> at the current time, frame for frame
// the way revideo will export it. The geometry/timing come from the compositor
// math (imported, not copied — see lib/compositor.ts); only the *cosmetic* draw
// (gradient / rounded clip / shadow / ripples / cursor) is reimplemented here in
// canvas 2D, mirroring scene.tsx. That cosmetic layer is the sole fidelity
// surface, and the spike proved it matches the export to the pixel.
//
// Clock model (the subtle bit):
//   • While the video is playing and hasn't reached its end, the VIDEO is the
//     clock (t = video.currentTime) so overlay and frame can never drift.
//   • A composition's timeline (stage.T) outlasts the video by the final
//     zoom-out tail. Past the video's end we keep our own wall-clock running
//     from the video duration up to stage.T, drawing the held last frame while
//     the stage eases back to rest — so the *ending* previews faithfully too.
//   • Scrubbing seeks the video; rapid seeks are coalesced (only the latest
//     target is honoured) so dragging the playhead stays responsive.

import { buildLegs, cursorPos, gradientEndpoints, isDragging } from "../lib/compositor";
import type { TakeComposition } from "../lib/compositor";
import { type Derived, derive } from "../lib/derive";

// arrow cursor, tip at local (0,0) — identical to scene.tsx CURSOR
const CURSOR_PTS: [number, number][] = [
  [0, 0],
  [0, 17],
  [4.5, 13],
  [7.5, 19.5],
  [10, 18.3],
  [7, 11.7],
  [12, 11.7],
];

export type EngineState = "playing" | "paused" | "ended";

export type OverlayConfig = {
  /** draw the active beat's zoom region / center / click point on the frame */
  enabled: boolean;
  /** which beat to highlight; -1 = none */
  beatIndex: number;
};

type Listeners = {
  time: Set<(t: number) => void>;
  state: Set<(s: EngineState) => void>;
  loaded: Set<(d: Derived) => void>;
};

export class PreviewEngine {
  private ctx: CanvasRenderingContext2D;
  private video: HTMLVideoElement;
  private comp!: TakeComposition;
  private d!: Derived;
  private legs: ReturnType<typeof buildLegs> = [];

  private t = 0;
  private raf = 0;
  private state: EngineState = "paused";
  private vDur = 0;
  loop = false;

  // tail clock (drawing past the video's last frame)
  private tailAnchorNow: number | null = null;
  private tailAnchorT = 0;

  // seek coalescing
  private seeking = false;
  private seekDirty = false;

  private overlay: OverlayConfig = { enabled: false, beatIndex: -1 };

  /** Inspect mode: draw the WIDE diagnostic frame (camera at rest, centred)
   *  regardless of the timeline's zoom state — the canvas under the editor's
   *  zoom-region box. Playback should switch it off. */
  private inspect = false;
  setInspectMode(on: boolean) {
    if (this.inspect === on) return;
    this.inspect = on;
    if (!this.isPlaying) this.drawFrame(this.t);
  }

  private listeners: Listeners = { time: new Set(), state: new Set(), loaded: new Set() };

  constructor(canvas: HTMLCanvasElement, video: HTMLVideoElement) {
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("2D canvas context unavailable");
    this.ctx = ctx;
    this.video = video;
    video.addEventListener("seeked", this.onSeeked);
    video.addEventListener("ended", this.onEnded);
  }

  // --- subscriptions -----------------------------------------------------
  on<K extends keyof Listeners>(ev: K, cb: Parameters<Listeners[K]["add"]>[0]): () => void {
    (this.listeners[ev] as Set<unknown>).add(cb);
    return () => (this.listeners[ev] as Set<unknown>).delete(cb);
  }
  private emitTime() {
    for (const cb of this.listeners.time) cb(this.t);
  }
  private setState(s: EngineState) {
    if (this.state === s) return;
    this.state = s;
    for (const cb of this.listeners.state) cb(s);
  }

  // --- loading -----------------------------------------------------------
  setComposition(comp: TakeComposition) {
    this.comp = comp;
    this.d = derive(comp);
    this.legs = buildLegs(comp);
    const cv = this.ctx.canvas;
    cv.width = comp.output.width;
    cv.height = comp.output.height;
    for (const cb of this.listeners.loaded) cb(this.d);
    this.drawFrame(this.t);
  }

  /** Load a video by URL or object-URL; resolves once a frame is decodable. */
  loadVideo(src: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const v = this.video;
      const onReady = () => {
        v.removeEventListener("error", onErr);
        this.vDur = v.duration || (this.comp ? this.comp.durationMs / 1000 : 0);
        this.t = 0;
        // first decode → draw frame 0
        const drawFirst = () => {
          this.drawFrame(0);
          this.emitTime();
          resolve();
        };
        if (v.readyState >= 2) drawFirst();
        else v.addEventListener("loadeddata", drawFirst, { once: true });
      };
      const onErr = () => reject(new Error("video failed to load"));
      v.addEventListener("loadeddata", onReady, { once: true });
      v.addEventListener("error", onErr, { once: true });
      v.src = src;
      v.load();
    });
  }

  get derived(): Derived {
    return this.d;
  }
  get currentTime(): number {
    return this.t;
  }
  get duration(): number {
    return this.d ? this.d.T : 0;
  }
  get isPlaying(): boolean {
    return this.state === "playing";
  }

  // --- transport ---------------------------------------------------------
  play() {
    if (!this.d) return;
    if (this.t >= this.d.T - 1e-3) this.t = 0; // restart from the top at the end
    const inTail = this.t >= this.vDur - 1e-3;
    this.tailAnchorNow = null;
    if (!inTail) {
      const vt = Math.min(this.t, Math.max(0, this.vDur - 1e-3));
      if (Math.abs(this.video.currentTime - vt) > 0.05) this.video.currentTime = vt;
      void this.video.play().catch(() => {});
    }
    this.setState("playing");
    this.raf = requestAnimationFrame(this.tick);
  }

  pause() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.video.pause();
    this.setState(this.t >= this.d?.T - 1e-3 ? "ended" : "paused");
  }

  toggle() {
    this.isPlaying ? this.pause() : this.play();
  }

  restart() {
    this.seek(0);
    this.play();
  }

  setLoop(on: boolean) {
    this.loop = on;
  }

  setOverlay(cfg: Partial<OverlayConfig>) {
    this.overlay = { ...this.overlay, ...cfg };
    if (!this.isPlaying) this.drawFrame(this.t); // refresh the still
  }

  /** Scrub to time t (seconds). Pauses playback; coalesces rapid calls. */
  seek(time: number) {
    if (!this.d) return;
    const t = Math.max(0, Math.min(this.d.T, time));
    this.t = t;
    if (this.isPlaying) this.pause();
    this.emitTime();

    const vt = Math.min(t, Math.max(0, this.vDur - 1e-3));
    if (Math.abs(this.video.currentTime - vt) < 1e-3) {
      this.drawFrame(t); // already on the right frame (e.g. anywhere in the tail)
      return;
    }
    if (this.seeking) {
      this.seekDirty = true;
      return;
    }
    this.seeking = true;
    this.video.currentTime = vt;
  }

  // --- internal ----------------------------------------------------------
  private tick = (now: number) => {
    if (this.state !== "playing") return;
    let t: number;
    if (this.video.ended || this.video.currentTime >= this.vDur - 1e-3) {
      // tail: video holds its last frame, our wall-clock drives the zoom-out
      if (this.tailAnchorNow == null) {
        this.tailAnchorNow = now;
        this.tailAnchorT = Math.max(this.t, this.vDur);
      }
      t = this.tailAnchorT + (now - this.tailAnchorNow) / 1000;
    } else {
      this.tailAnchorNow = null;
      t = this.video.currentTime;
    }

    if (t >= this.d.T) {
      this.t = this.d.T;
      this.drawFrame(this.t);
      this.emitTime();
      if (this.loop) {
        this.seek(0);
        this.play();
        return;
      }
      this.pause();
      return;
    }

    this.t = t;
    this.drawFrame(t);
    this.emitTime();
    this.raf = requestAnimationFrame(this.tick);
  };

  private onSeeked = () => {
    this.seeking = false;
    this.drawFrame(this.t);
    if (this.seekDirty) {
      this.seekDirty = false;
      const vt = Math.min(this.t, Math.max(0, this.vDur - 1e-3));
      if (Math.abs(this.video.currentTime - vt) > 1e-3) {
        this.seeking = true;
        this.video.currentTime = vt;
      }
    }
  };

  private onEnded = () => {
    // let the tick loop carry the tail; nothing to do if paused
  };

  dispose() {
    cancelAnimationFrame(this.raf);
    this.video.removeEventListener("seeked", this.onSeeked);
    this.video.removeEventListener("ended", this.onEnded);
    this.video.pause();
    this.video.removeAttribute("src");
    this.video.load();
  }

  // --- the draw (faithful to scene.tsx) ----------------------------------
  /** Public entry: draw the frame at time t (motion-blurred if configured), then
   *  the editor overlay on top (unblurred — an affordance, not part of the frame). */
  drawFrame(t: number) {
    if (!this.d) return;
    if (this.inspect) {
      this.drawSceneAt(this.ctx, t); // rest-framed via the inspect override, no blur
      return;
    }
    const mb = this.comp.motionBlur;
    if (mb && mb.samples > 1 && mb.shutter > 0) this.drawBlurred(t, mb.samples, mb.shutter);
    else this.drawSceneAt(this.ctx, t);
    if (this.overlay.enabled) this.drawOverlay(t, this.d.scaleAt(t), this.d.centerAt(t));
  }

  /** Temporal-supersampling motion blur — mirrors the export (render at fps·samples
   *  + ffmpeg tmix): average `samples` scene draws over a trailing shutter window.
   *  Each sub-sample reuses the SAME decoded video frame (so only the CAMERA move +
   *  cursor blur, not the recording's content) with camera/cursor sampled at the
   *  sub-time. Mean via additive ('lighter') compositing at 1/samples from black. */
  private drawBlurred(t: number, samples: number, shutter: number) {
    const oW = this.comp.output.width,
      oH = this.comp.output.height;
    const win = shutter / this.comp.output.fps; // shutter window in seconds (trailing)
    const off = this.ensureBlurCanvas(oW, oH);
    const main = this.ctx;
    main.save();
    main.globalCompositeOperation = "source-over";
    main.globalAlpha = 1;
    main.fillStyle = "#000";
    main.fillRect(0, 0, oW, oH);
    main.globalCompositeOperation = "lighter";
    main.globalAlpha = 1 / samples;
    for (let k = 0; k < samples; k++) {
      off.clearRect(0, 0, oW, oH);
      this.drawSceneAt(off, Math.max(0, t - win * (k / samples)));
      main.drawImage(off.canvas, 0, 0);
    }
    main.restore();
  }

  /** Draw ONE scene sample (camera + video + ripples + cursor) at time t to ctx. */
  private drawSceneAt(ctx: CanvasRenderingContext2D, t: number) {
    const comp = this.comp;
    const vW = comp.source.videoWidth,
      vH = comp.source.videoHeight;
    const oW = comp.output.width,
      oH = comp.output.height;
    const s = this.inspect ? this.d.rest : this.d.scaleAt(t);
    const c = this.inspect ? { x: vW / 2, y: vH / 2 } : this.d.centerAt(t);

    // Composition camera: the backdrop is part of the
    // composition and is zoomed by the SAME camera as the screen (not a static
    // layer the video overfills). A zoom crops into the screen (it fills the
    // frame; backdrop cropped out), and zoom-OUT is ONE uniform motion field —
    // the backdrop slides back in with no static-edge reveal (kills the two-stage
    // stutter). Mirrors scene.tsx. Camera: zoom z=s/rest about target T (comp px).
    const rest = this.d.rest;
    const z = s / rest;
    const Tx = oW / 2 + rest * (c.x - vW / 2);
    const Ty = oH / 2 + rest * (c.y - vH / 2);
    const cam = (px: number, py: number): [number, number] => [
      oW / 2 + z * (px - Tx),
      oH / 2 + z * (py - Ty),
    ];

    // backdrop: solid fill, or a linear gradient whose endpoints ride the camera
    // so the gradient zooms/pans with the composition.
    const bg = comp.framing.background;
    if (bg.type === "solid") {
      ctx.fillStyle = bg.from;
    } else {
      const e = gradientEndpoints(bg.angle, oW, oH);
      const [gx0, gy0] = cam(e.x0, e.y0);
      const [gx1, gy1] = cam(e.x1, e.y1);
      const g = ctx.createLinearGradient(gx0, gy0, gx1, gy1);
      g.addColorStop(0, bg.from);
      g.addColorStop(1, bg.to);
      ctx.fillStyle = g;
    }
    ctx.fillRect(0, 0, oW, oH);

    // video rect: video-px (px,py) → screen (oW/2 + s·(px−c.x), …). At high zoom
    // it overfills the output (fills the frame); the rounded corners + shadow are
    // the screen frame and ride off-screen when zoomed.
    const x = oW / 2 - s * c.x;
    const y = oH / 2 - s * c.y;
    const w = vW * s,
      h = vH * s;
    const r = comp.framing.cornerRadius * s;

    // drop shadow under the rounded video rect
    ctx.save();
    ctx.shadowColor = comp.framing.shadow.color;
    ctx.shadowBlur = comp.framing.shadow.blur * s;
    ctx.shadowOffsetX = comp.framing.shadow.offset.x * s;
    ctx.shadowOffsetY = comp.framing.shadow.offset.y * s;
    ctx.fillStyle = "#0a0e1c";
    this.roundRect(ctx, x, y, w, h, r);
    ctx.fill();
    ctx.restore();

    // clipped video
    ctx.save();
    this.roundRect(ctx, x, y, w, h, r);
    ctx.clip();
    try {
      ctx.drawImage(this.video, x, y, w, h);
    } catch {
      /* not yet decodable */
    }
    ctx.restore();

    // click ripples (scroll/press have no spatial point — skipped, as in scene)
    for (const e of comp.events) {
      if (e.kind === "scroll" || e.kind === "press") continue;
      const ms = comp.cursor.rippleMs / 1000;
      const dt = t - e.tMs / 1000;
      if (dt < 0 || dt > ms) continue;
      const p = dt / ms;
      const rad = 12 + 60 * smoothstep(p);
      const sx = oW / 2 + s * (e.point.x - c.x);
      const sy = oH / 2 + s * (e.point.y - c.y);
      ctx.save();
      ctx.globalAlpha = (150 * (1 - p)) / 255;
      ctx.strokeStyle = "white";
      ctx.lineWidth = 4 * s;
      ctx.beginPath();
      ctx.arc(sx, sy, rad * s, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    // synthetic cursor (scales with the stage)
    const cur = cursorPos(t, this.legs, comp);
    const csx = oW / 2 + s * (cur.x - c.x);
    const csy = oH / 2 + s * (cur.y - c.y);
    const drawPoly = (off: number, fill: string | null, stroke: string | null) => {
      ctx.beginPath();
      CURSOR_PTS.forEach(([px, py], i) => {
        const X = csx + (px * comp.cursor.scale + off) * s;
        const Y = csy + (py * comp.cursor.scale + off) * s;
        i === 0 ? ctx.moveTo(X, Y) : ctx.lineTo(X, Y);
      });
      ctx.closePath();
      if (fill) {
        ctx.fillStyle = fill;
        ctx.fill();
      }
      if (stroke) {
        ctx.strokeStyle = stroke;
        ctx.lineWidth = 2 * s;
        ctx.stroke();
      }
    };
    if (isDragging(t, this.legs)) {
      ctx.save();
      ctx.fillStyle = "rgba(255,255,255,0.16)";
      ctx.strokeStyle = "white";
      ctx.lineWidth = 2 * s;
      ctx.beginPath();
      ctx.arc(csx, csy, 15 * s, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
    drawPoly(2.5, "rgba(0,0,0,0.35)", null); // soft shadow
    drawPoly(0, "rgb(20,20,24)", "white"); // body
  }

  /** Editor affordance layer (NOT part of the faithful frame): outlines the
   *  highlighted beat's zoom region, center, and click point in screen space.
   *  Drawn after the faithful frame so playback frames carry it too. */
  private drawOverlay(_t: number, s: number, c: { x: number; y: number }) {
    const comp = this.comp;
    const ctx = this.ctx;
    const oW = comp.output.width,
      oH = comp.output.height;
    const i = this.overlay.beatIndex;
    if (i < 0 || i >= comp.events.length) return;
    const e = comp.events[i]!;
    const toScreen = (px: number, py: number) =>
      [oW / 2 + s * (px - c.x), oH / 2 + s * (py - c.y)] as const;
    const AMBER = "#ffb454";

    ctx.save();
    ctx.lineWidth = 2.5;
    // element bbox (the framed region)
    if (e.bbox) {
      const [bx, by] = toScreen(e.bbox.x, e.bbox.y);
      ctx.setLineDash([12, 8]);
      ctx.strokeStyle = AMBER;
      ctx.strokeRect(bx, by, e.bbox.w * s, e.bbox.h * s);
      ctx.setLineDash([]);
    }
    // zoom center crosshair
    if (e.zoom.enabled) {
      const [cx, cy] = toScreen(e.zoom.center.x, e.zoom.center.y);
      ctx.strokeStyle = AMBER;
      ctx.beginPath();
      ctx.moveTo(cx - 16, cy);
      ctx.lineTo(cx + 16, cy);
      ctx.moveTo(cx, cy - 16);
      ctx.lineTo(cx, cy + 16);
      ctx.stroke();
    }
    // click / anchor point
    const [px, py] = toScreen(e.point.x, e.point.y);
    ctx.fillStyle = AMBER;
    ctx.beginPath();
    ctx.arc(px, py, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  private roundRect(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    r: number,
  ) {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
  }

  // offscreen canvas for motion-blur accumulation (lazy, resized with output)
  private blur?: { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D };
  private ensureBlurCanvas(w: number, h: number): CanvasRenderingContext2D {
    if (!this.blur || this.blur.canvas.width !== w || this.blur.canvas.height !== h) {
      const canvas = this.ctx.canvas.ownerDocument.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const cx = canvas.getContext("2d", { alpha: true });
      if (!cx) throw new Error("2D offscreen context unavailable");
      this.blur = { canvas, ctx: cx };
    }
    return this.blur.ctx;
  }
}

// local copy of math.ts smoother for the ripple curve (avoids a named import
// clash with the re-export module; identical formula)
function smoothstep(t: number): number {
  const clamped = Math.max(0, Math.min(1, t));
  return clamped * clamped * clamped * (clamped * (clamped * 6 - 15) + 10);
}
