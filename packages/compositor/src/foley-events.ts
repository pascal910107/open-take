// The compositor's timelines, spelled as open-foley EVENT SHEETS.
//
// This is the whole reason sound can be deterministic here: a take already
// knows every click, keystroke, drag and camera move to the millisecond, and a
// launch film already knows every entrance, slide and cut — the same moments a
// foley artist would otherwise have to find by watching the picture. These two
// functions only translate; they decide nothing about sound. The event sheet
// vocabulary is open-foley's (cues.ts there); it is mirrored structurally so
// the compositor does not depend on the foley package for a type.

import { launchSceneWindows, uiStateDurationS } from "./launch-evaluate";
import type { LaunchComposition, LaunchScene } from "./launch-types";
import { buildStageKeyframes, stageCamera } from "./math";
import type { MotionLayer, MotionScene, MotionTrack } from "./motion-types";
import type { StateIndex } from "./state-index";
import { directTake } from "./take-recipes";
import type { CaptureLog, TakeComposition } from "./types";

export type FoleyEvent = {
  kind:
    | "click"
    | "key"
    | "tap"
    | "enter"
    | "exit"
    | "move"
    | "zoom-in"
    | "zoom-out"
    | "pan"
    | "transition"
    | "reveal"
    | "notify"
    | "build"
    | "drop";
  atS: number;
  durationS?: number;
  intensity?: number;
  extent?: number;
  pan?: number;
  label?: string;
};

export type FoleyEventSheet = { version: 1; durationS: number; events: FoleyEvent[] };

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

/** Keystroke instants for text typed over a window: evenly spaced, one per
 *  character, each centred in its slot (the capture types at a steady pace). */
function keystrokes(startS: number, durationS: number, chars: number): number[] {
  const n = Math.max(1, chars);
  return Array.from({ length: n }, (_, i) => startS + (durationS * (i + 0.5)) / n);
}

// --- actions (shared by the take and the raw capture) --------------------

/** One recorded action in whichever coordinate space the source uses; `w` is
 *  that space's width (for pan and move extent). */
type Action = {
  kind: "click" | "type" | "drag" | "scroll" | "hover" | "look" | "press" | "dropFiles";
  tMs: number;
  durationMs: number;
  x: number;
  y: number;
  toX?: number;
  toY?: number;
  text?: string;
  keys?: string;
  /** a press that located its reveal element */
  hasBox: boolean;
  changeCoverage?: number;
  label: string;
};

function actionEvents(actions: Action[], w: number, push: (e: FoleyEvent) => void): void {
  const pan = (x: number) => r3(clamp01(x / w) * 2 - 1);
  for (const e of actions) {
    const t = e.tMs / 1000;
    const d = e.durationMs / 1000;
    const label = e.label;
    const p = pan(e.x);
    switch (e.kind) {
      case "click":
        push({ kind: "click", atS: t, intensity: 0.55, pan: p, label });
        break;
      case "type": {
        const chars = (e.text ?? "").length;
        for (const k of keystrokes(t, d, chars))
          push({ kind: "key", atS: k, intensity: 0.4, pan: p, label });
        if (d >= 1.2 && chars >= 6)
          push({
            kind: "build",
            atS: t,
            durationS: r3(d),
            intensity: 0.5,
            label: `${label} (typing)`,
          });
        break;
      }
      case "press":
        push({ kind: "key", atS: t, intensity: 0.65, pan: p, label: e.keys ?? label });
        if (e.hasBox)
          push({
            kind: "enter",
            atS: t + 0.12,
            intensity: 0.5,
            pan: p,
            label: `${e.keys ?? label} → result`,
          });
        break;
      case "drag":
      case "dropFiles": {
        const toX = e.toX ?? e.x;
        const toY = e.toY ?? e.y;
        const dist = Math.hypot(toX - e.x, toY - e.y);
        push({
          kind: "move",
          atS: t,
          durationS: r3(d),
          extent: r3(clamp01(dist / w)),
          intensity: 0.5,
          pan: pan((e.x + toX) / 2),
          label,
        });
        if (e.kind === "dropFiles")
          push({ kind: "drop", atS: t + d, intensity: 0.6, pan: pan(toX), label });
        break;
      }
      case "scroll":
        push({
          kind: "move",
          atS: t,
          durationS: r3(d),
          extent: 0.3,
          intensity: 0.35,
          pan: p,
          label,
        });
        break;
      case "hover":
      case "look":
        break;
    }
    if ((e.changeCoverage ?? 0) >= 0.55)
      push({
        kind: "transition",
        atS: t + 0.1,
        intensity: 0.6,
        extent: r3(e.changeCoverage ?? 0),
        label: `${label} (repaint)`,
      });
  }
}

/** A raw capture's moments on the CAPTURE timeline (t=0 = the recording's
 *  first frame) — for footage that is the unpolished capture itself. */
export function captureEventSheet(log: CaptureLog): FoleyEventSheet {
  const events: FoleyEvent[] = [];
  const push = (e: FoleyEvent) => events.push({ ...e, atS: r3(e.atS) });
  actionEvents(
    log.events.map((e) => {
      const kind = e.kind ?? "click";
      const to = "to" in e ? e.to : undefined;
      return {
        kind,
        tMs: e.tMs,
        durationMs: "durationMs" in e ? e.durationMs : 0,
        x: e.x,
        y: e.y,
        toX: to?.x,
        toY: to?.y,
        text: kind === "type" ? (e as { text: string }).text : undefined,
        keys: kind === "press" ? (e as { keys: string }).keys : undefined,
        hasBox: !!e.box,
        changeCoverage: e.changeCoverage,
        label: e.note ?? e.sel ?? kind,
      };
    }),
    log.viewport.w,
    push,
  );
  events.sort((x, y) => x.atS - y.atS);
  const last = log.events.at(-1);
  const end = Math.max(
    log.tEndMs ?? 0,
    log.video.durationS != null ? log.video.durationS * 1000 : 0,
    last ? last.tMs + ("durationMs" in last ? last.durationMs : 0) + 1000 : 0,
  );
  return { version: 1, durationS: r3(end / 1000), events };
}

// --- take ----------------------------------------------------------------

/** A take's moments on the COMPOSITION timeline (untrimmed — the caller mixes
 *  with the delivered head trim as `offsetS`, exactly like captions). */
export function takeEventSheet(comp: TakeComposition): FoleyEventSheet {
  const vW = comp.source.videoWidth;
  const pan = (x: number) => r3(clamp01(x / vW) * 2 - 1);
  const events: FoleyEvent[] = [];
  const push = (e: FoleyEvent) => events.push({ ...e, atS: r3(e.atS) });

  if (comp.titleCard) push({ kind: "notify", atS: 0.05, intensity: 0.4, label: "title card" });

  actionEvents(
    comp.events.map((e) => ({
      kind: e.kind,
      tMs: e.tMs,
      durationMs: e.durationMs ?? 0,
      x: e.point.x,
      y: e.point.y,
      toX: e.to?.x,
      toY: e.to?.y,
      text: e.text,
      keys: e.keys,
      hasBox: !!e.bbox,
      changeCoverage: e.changeCoverage,
      label: e.label ?? e.kind,
    })),
    vW,
    push,
  );

  for (const c of comp.captions ?? [])
    push({
      kind: "enter",
      atS: c.fromMs / 1000,
      intensity: 0.3,
      extent: 0.2,
      label: `caption: ${c.text.slice(0, 24)}`,
    });

  // camera: every rect segment that changes is a move; the LAST keyframe is
  // the padding hold and never a move.
  const kfs = buildStageKeyframes(comp).r;
  for (let i = 0; i < kfs.length - 1; i++) {
    const [t0, a] = kfs[i]!;
    const [t1, b] = kfs[i + 1]!;
    const dur = t1 - t0;
    if (dur <= 0.02) continue;
    const ratio = b.w / a.w;
    const shift = Math.hypot(b.cx - a.cx, b.cy - a.cy);
    if (ratio < 0.98)
      push({
        kind: "zoom-in",
        atS: t0,
        durationS: r3(dur),
        extent: r3(1 - ratio),
        intensity: 0.5,
        pan: pan(b.cx),
        label: "camera in",
      });
    else if (ratio > 1.02)
      push({
        kind: "zoom-out",
        atS: t0,
        durationS: r3(dur),
        extent: r3(1 - 1 / ratio),
        intensity: 0.45,
        pan: pan(b.cx),
        label: "camera out",
      });
    else if (shift > vW * 0.03)
      push({
        kind: "pan",
        atS: t0,
        durationS: r3(dur),
        extent: r3(clamp01(shift / vW)),
        intensity: 0.35,
        pan: pan(b.cx),
        label: "camera pan",
      });
  }

  events.sort((x, y) => x.atS - y.atS);
  return { version: 1, durationS: r3(stageCamera(comp).T), events };
}

// --- launch --------------------------------------------------------------

/** What a footage asset was cut from: a polished take (its composition) or
 *  the raw capture (its log). */
export type FootageSource =
  | { kind: "take"; composition: TakeComposition }
  /** a raw capture; `states` are its saved screens, when it has them (the
   *  launch camera reads what each action changed off them) */
  | { kind: "capture"; log: CaptureLog; states?: Map<string, StateIndex> };

export type LaunchEventSheetOpts = {
  /** resolve a footage / video asset path (as written in the composition,
   *  plus the layer's explicit `take` when it has one) to the recording it
   *  came from, so the clicks and keystrokes INSIDE the footage get their
   *  sounds too */
  takeFor?: (asset: string, explicit?: string) => FootageSource | undefined;
};

/** Inline a recording's events into a film window. For a polished take the
 *  asset's t=0 is its delivered head (composition time startMs); for a raw
 *  capture it is the capture's t=0. The layer shows source time from
 *  `trimStartS` starting at film time `atS`, for `durationS`. */
function inlineTake(
  source: FootageSource,
  atS: number,
  trimStartS: number,
  durationS: number,
  events: FoleyEvent[],
  label: string,
  /** shown through a camera group: the take's own camera moves are heard too */
  camera = false,
): void {
  const head = source.kind === "take" ? (source.composition.startMs ?? 0) / 1000 : 0;
  const sheet =
    source.kind === "take"
      ? takeEventSheet(source.composition)
      : camera
        ? takeEventSheet(directTake(source.log, source.states).comp)
        : captureEventSheet(source.log);
  for (const e of sheet.events) {
    const filmT = atS + (e.atS - head - trimStartS);
    if (filmT < atS - 0.001 || filmT > atS + durationS + 0.001) continue;
    events.push({ ...e, atS: r3(filmT), label: `${label}: ${e.label ?? e.kind}` });
  }
}

type Segment = { t0: number; t1: number; v0: number; v1: number; easing: string };
function segments(track: MotionTrack): Segment[] {
  const out: Segment[] = [];
  const k = track.keyframes;
  for (let i = 0; i < k.length - 1; i++) {
    const a = k[i]!;
    const b = k[i + 1]!;
    if (typeof a.value !== "number" || typeof b.value !== "number") continue;
    if (a.value === b.value) continue;
    out.push({ t0: a.atS, t1: b.atS, v0: a.value, v1: b.value, easing: b.easing ?? "linear" });
  }
  return out;
}

const ENTER_INTENSITY: Record<MotionLayer["type"], number> = {
  wipe: 0,
  text: 0.35,
  group: 0.45,
  image: 0.5,
  video: 0.5,
  state: 0.5,
  cursor: 0,
  rect: 0.3,
  ellipse: 0.3,
  line: 0.25,
};

function motionSceneEvents(
  scene: MotionScene,
  startS: number,
  events: FoleyEvent[],
  opts: LaunchEventSheetOpts,
  designW: number,
  designH: number,
): void {
  const pan = (x: number | undefined) => (x == null ? 0 : r3(clamp01(x / designW) * 2 - 1));
  const walk = (layer: MotionLayer, parentPan: number, inCamera = false) => {
    const p = layer.x == null ? parentPan : pan(layer.x);
    const label = layer.id;
    if (layer.type === "group" && layer.camera) {
      // the camera over a recording: its moves are the take's camera, voiced
      // from the take itself (below) — never a sampled track read as slides
      for (const child of layer.children) walk(child, parentPan, true);
      return;
    }
    if (layer.type === "wipe") {
      // a section change: the sweep is heard as it races through the frame
      const d = layer.durationS ?? 0.45;
      events.push({
        kind: "transition",
        atS: r3(startS + layer.atS + d * 0.6),
        intensity: 0.7,
        extent: 1,
        pan: layer.direction === "left" ? 0.3 : -0.3,
        label: `${label} (wipe)`,
      });
      return;
    }
    // Only things with presence in the frame whoosh when they move. A
    // cursor-sized sprite crossing the frame is carried by its clicks, and a
    // line of text rising in is an entrance (its `enter` taps) — a whoosh on
    // each of them is what made a whole film go "咻咻咻" (Pascal, 2026-09-29).
    const size =
      "width" in layer && "height" in layer && layer.width != null && layer.height != null
        ? (layer.width * layer.height) / (designW * designH)
        : 1;
    const slides = size >= 0.01 && layer.type !== "text" && layer.type !== "cursor";
    const moves = new Map<number, { t0: number; t1: number; dx: number; dy: number }>();
    for (const track of layer.animations ?? []) {
      for (const s of segments(track)) {
        const at = startS + s.t0;
        const dur = Math.max(0, s.t1 - s.t0);
        switch (track.property) {
          case "opacity":
            if (s.v0 < 0.5 && s.v1 >= 0.5)
              events.push({
                kind: "enter",
                atS: r3(startS + s.t1),
                intensity: ENTER_INTENSITY[layer.type],
                extent: 0.3,
                pan: p,
                label,
              });
            else if (s.v0 >= 0.5 && s.v1 < 0.5)
              events.push({ kind: "exit", atS: r3(at), intensity: 0.3, pan: p, label });
            break;
          case "x":
          case "y": {
            const m = moves.get(s.t0) ?? { t0: s.t0, t1: s.t1, dx: 0, dy: 0 };
            if (track.property === "x") m.dx = s.v1 - s.v0;
            else m.dy = s.v1 - s.v0;
            m.t1 = Math.max(m.t1, s.t1);
            moves.set(s.t0, m);
            break;
          }
          case "scaleX":
          case "scaleY":
            // a pop-in is an entrance; a slow linear push through a hold is not
            if (
              track.property === "scaleX" &&
              s.v1 > 0 &&
              (s.v1 - s.v0) / s.v1 >= 0.05 &&
              s.easing !== "linear"
            )
              events.push({
                kind: "enter",
                atS: r3(startS + s.t1),
                intensity: 0.6,
                extent: 0.4,
                pan: p,
                label: `${label} (scale)`,
              });
            break;
          case "reveal":
            if (layer.type === "text" && s.v1 > s.v0) {
              const chars = Math.min(60, layer.text.length);
              for (const k of keystrokes(at, dur, chars))
                events.push({
                  kind: "key",
                  atS: r3(k),
                  intensity: 0.4,
                  pan: p,
                  label: `${label} (reveal)`,
                });
            }
            break;
          // "end": a line drawing on is a detail, not a move — silent
          default:
            break;
        }
      }
    }
    for (const m of slides ? moves.values() : []) {
      const dist = Math.hypot(m.dx / designW, m.dy / designH);
      events.push({
        kind: "move",
        atS: r3(startS + m.t0),
        durationS: r3(m.t1 - m.t0),
        extent: r3(clamp01(dist)),
        intensity: 0.5,
        pan: p,
        label: `${label} (slide)`,
      });
    }
    if (layer.type === "video" && opts.takeFor) {
      const source = opts.takeFor(layer.asset, layer.take);
      if (source)
        inlineTake(
          source,
          startS + (layer.startS ?? 0),
          layer.trimStartS ?? 0,
          layer.durationS,
          events,
          label,
          inCamera,
        );
    }
    if (layer.type === "group") for (const child of layer.children) walk(child, p, inCamera);
  };
  for (const layer of scene.layers) walk(layer, 0);
}

/** A launch film's moments on the film timeline. */
export function launchEventSheet(
  comp: LaunchComposition,
  opts: LaunchEventSheetOpts = {},
): FoleyEventSheet {
  const events: FoleyEvent[] = [];
  const windows = launchSceneWindows(comp);
  for (const { scene, index, startS, endS } of windows) {
    const s = scene as LaunchScene;
    if (index > 0) {
      const tr = s.transition?.type ?? "cut";
      events.push({
        kind: "transition",
        atS: r3(startS),
        intensity: tr === "cut" ? 0.6 : tr === "slide" ? 0.7 : 0.4,
        extent: 1,
        label: `${s.id} (${tr})`,
      });
    }
    switch (s.type) {
      case "title": {
        events.push({ kind: "notify", atS: r3(startS + 0.05), intensity: 0.45, label: s.id });
        if (s.motion !== "off")
          s.lines.forEach((line, i) => {
            events.push({
              kind: "enter",
              atS: r3(startS + 0.3 + i * (s.staggerS ?? 0.25)),
              intensity: 0.4,
              extent: 0.4,
              label: `${s.id}: ${line.slice(0, 24)}`,
            });
          });
        break;
      }
      case "end-card":
        events.push({
          kind: "reveal",
          atS: r3(startS + 0.3),
          intensity: 0.8,
          extent: 1,
          label: `${s.id}: ${s.headline.slice(0, 24)}`,
        });
        break;
      case "footage": {
        events.push({ kind: "enter", atS: r3(startS), intensity: 0.5, extent: 0.8, label: s.id });
        const source = opts.takeFor?.(s.asset, s.take);
        if (source) inlineTake(source, startS, s.trimStartS ?? 0, endS - startS, events, s.id);
        break;
      }
      case "ui-morph": {
        let cursor = startS;
        for (const state of s.states) {
          events.push({
            kind: "move",
            atS: r3(cursor),
            durationS: r3(state.transitionS),
            extent: 0.35,
            intensity: 0.5,
            label: `${s.id}: ${state.label}`,
          });
          for (const k of keystrokes(cursor + state.typeDelayS, state.typeS, state.prompt.length))
            events.push({
              kind: "key",
              atS: r3(k),
              intensity: 0.4,
              label: `${s.id}: ${state.label} (typing)`,
            });
          cursor += uiStateDurationS(state);
        }
        break;
      }
      case "motion":
        motionSceneEvents(
          s,
          startS,
          events,
          opts,
          s.designSize?.width ?? comp.output.width,
          s.designSize?.height ?? comp.output.height,
        );
        break;
    }
  }
  // the story's payoff beats are the film's reveals — the one moment a
  // timeline cannot tell from its geometry alone
  for (const beat of comp.story?.beats ?? []) {
    if (beat.role !== "payoff") continue;
    const win = windows.find((w) => w.scene.id === beat.sceneId);
    if (!win) continue;
    events.push({
      kind: "reveal",
      atS: r3(win.startS + (beat.startS ?? 0)),
      intensity: 0.85,
      extent: 1,
      label: `payoff: ${beat.message.slice(0, 32)}`,
    });
  }
  events.sort((x, y) => x.atS - y.atS);
  // a click's own indicator (the ripple, the pressed state) appears on the
  // click: it is part of that click, not a second arrival — without this
  // every click sounds twice (click + tap)
  const clicks = events.filter((e) => e.kind === "click").map((e) => e.atS);
  const deduped = events.filter(
    (e) => e.kind !== "enter" || !clicks.some((t) => Math.abs(t - e.atS) <= 0.06),
  );
  return { version: 1, durationS: r3(windows.at(-1)?.endS ?? 0), events: deduped };
}
