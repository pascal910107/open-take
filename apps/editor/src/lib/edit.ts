// Pure, structural-sharing setters for the editable composition. Each returns a
// NEW TakeComposition that re-spreads only the touched spine — so an edit
// allocates a handful of objects, never a deep clone, and reference-equality
// stays meaningful (dirty checks, memo deps). These are the ONLY way the editor
// mutates a composition; useComposition feeds the result to the engine + React.
//
// They touch ONLY the editable boundary (framing / cursor / start / per-beat
// zoom / durations). Capture-locked fields (event.tMs, kind, order, text/keys)
// are never written here — the validator would reject a drift and the UI shows
// them read-only.

import type {
  CursorConfig,
  FramingConfig,
  MotionBlurConfig,
  Pt,
  TakeComposition,
  ZoomDecision,
} from "./compositor";

// --- framing -----------------------------------------------------------------

/** Top-level framing fields (insetFrac, cornerRadius). */
export function setFraming(
  c: TakeComposition,
  patch: Partial<Pick<FramingConfig, "insetFrac" | "cornerRadius">>,
): TakeComposition {
  return { ...c, framing: { ...c.framing, ...patch } };
}

export function setBackground(
  c: TakeComposition,
  patch: Partial<FramingConfig["background"]>,
): TakeComposition {
  return { ...c, framing: { ...c.framing, background: { ...c.framing.background, ...patch } } };
}

export function setShadow(
  c: TakeComposition,
  patch: Partial<Pick<FramingConfig["shadow"], "color" | "blur">>,
): TakeComposition {
  return { ...c, framing: { ...c.framing, shadow: { ...c.framing.shadow, ...patch } } };
}

export function setShadowOffset(c: TakeComposition, patch: Partial<Pt>): TakeComposition {
  return {
    ...c,
    framing: {
      ...c.framing,
      shadow: { ...c.framing.shadow, offset: { ...c.framing.shadow.offset, ...patch } },
    },
  };
}

// --- cursor ------------------------------------------------------------------

export function setCursor(c: TakeComposition, patch: Partial<CursorConfig>): TakeComposition {
  return { ...c, cursor: { ...c.cursor, ...patch } };
}

// --- start / duration --------------------------------------------------------

export function setStart(c: TakeComposition, patch: Partial<Pt>): TakeComposition {
  return { ...c, start: { ...c.start, ...patch } };
}

export function setDuration(c: TakeComposition, durationMs: number): TakeComposition {
  return { ...c, durationMs };
}

// --- per-beat ----------------------------------------------------------------

function patchEvent(
  c: TakeComposition,
  i: number,
  fn: (e: TakeComposition["events"][number]) => TakeComposition["events"][number],
): TakeComposition {
  if (i < 0 || i >= c.events.length) return c;
  const events = c.events.slice();
  events[i] = fn(events[i]!);
  return { ...c, events };
}

export function setBeatZoom(
  c: TakeComposition,
  i: number,
  patch: Partial<ZoomDecision>,
): TakeComposition {
  return patchEvent(c, i, (e) => ({ ...e, zoom: { ...e.zoom, ...patch } }));
}

export function setBeatCenter(c: TakeComposition, i: number, patch: Partial<Pt>): TakeComposition {
  return patchEvent(c, i, (e) => ({
    ...e,
    zoom: { ...e.zoom, center: { ...e.zoom.center, ...patch } },
  }));
}

export function setBeatGlide(c: TakeComposition, i: number, patch: Partial<Pt>): TakeComposition {
  return patchEvent(c, i, (e) => ({
    ...e,
    zoom: { ...e.zoom, glide: { x: e.zoom.glide?.x ?? 0, y: e.zoom.glide?.y ?? 0, ...patch } },
  }));
}

export function setBeatDuration(
  c: TakeComposition,
  i: number,
  durationMs: number,
): TakeComposition {
  return patchEvent(c, i, (e) => ({ ...e, durationMs }));
}

// --- v4 additions ------------------------------------------------------------

/** Motion blur on/off + params; undefined removes the key (renders exactly as
 *  the pre-blur path). */
export function setMotionBlur(
  c: TakeComposition,
  mb: MotionBlurConfig | undefined,
): TakeComposition {
  if (!mb) {
    const { motionBlur: _mb, ...rest } = c;
    return rest;
  }
  return { ...c, motionBlur: { ...mb } };
}

/** Apply a whole Look bundle (background + cornerRadius + shadow together) —
 *  the curated-look move; insetFrac is untouched. */
export function applyLook(
  c: TakeComposition,
  look: Pick<FramingConfig, "background" | "cornerRadius" | "shadow">,
): TakeComposition {
  return {
    ...c,
    framing: {
      ...c.framing,
      background: { ...look.background },
      cornerRadius: look.cornerRadius,
      shadow: { ...look.shadow, offset: { ...look.shadow.offset } },
    },
  };
}

/** Merge cursor fields AND rebase each beat's zoom.inAtMs that still sits on
 *  the old `tMs − zoomInMs` derivation, so pacing changes actually move the
 *  zoom ramps. Hand-tuned inAtMs values are left alone. (Mirrors the CLI `ab`
 *  pace knob.) */
export function setCursorRebased(
  c: TakeComposition,
  patch: Partial<CursorConfig>,
): TakeComposition {
  const next = { ...c.cursor, ...patch };
  if (patch.zoomInMs == null || patch.zoomInMs === c.cursor.zoomInMs) return { ...c, cursor: next };
  const oldZoomInMs = c.cursor.zoomInMs;
  const events = c.events.map((e) =>
    e.zoom.inAtMs === Math.max(0, e.tMs - oldZoomInMs)
      ? { ...e, zoom: { ...e.zoom, inAtMs: Math.max(0, e.tMs - next.zoomInMs) } }
      : e,
  );
  return { ...c, events, cursor: next };
}
