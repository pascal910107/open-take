import type {
  EvaluatedMotionLayer,
  EvaluatedMotionScene,
  MotionEasing,
  MotionHit,
  MotionLayer,
  MotionScene,
  MotionTextMoveName,
  MotionTextUnits,
  MotionTrack,
  MotionWipeLayer,
} from "./motion-types";

export type MotionColor = [number, number, number, number];
/** Same explicit color syntax as launch themes; no browser-dependent named colors. */
export function parseMotionColor(value: unknown): MotionColor | undefined {
  if (typeof value !== "string") return undefined;
  if (/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(value))
    return [
      Number.parseInt(value.slice(1, 3), 16),
      Number.parseInt(value.slice(3, 5), 16),
      Number.parseInt(value.slice(5, 7), 16),
      value.length === 9 ? Number.parseInt(value.slice(7, 9), 16) / 255 : 1,
    ];
  const m = value.match(
    /^(rgb|rgba)\(\s*(\d+(?:\.\d+)?|\.\d+)\s*,\s*(\d+(?:\.\d+)?|\.\d+)\s*,\s*(\d+(?:\.\d+)?|\.\d+)(?:\s*,\s*(\d+(?:\.\d+)?|\.\d+))?\s*\)$/i,
  );
  if (!m || (m[1]!.toLowerCase() === "rgba") !== (m[5] !== undefined)) return undefined;
  const rgba: MotionColor = [
    Number(m[2]),
    Number(m[3]),
    Number(m[4]),
    m[5] === undefined ? 1 : Number(m[5]),
  ];
  return rgba.every((n, i) => Number.isFinite(n) && n >= 0 && n <= (i === 3 ? 1 : 255))
    ? rgba
    : undefined;
}
const clamp = (value: number) => Math.max(0, Math.min(1, value));

/** CSS cubic-bezier(x1, y1, x2, y2): solve x(u) = t for the curve parameter
 *  (Newton, then bisection when the slope is flat), return y(u). */
function cubicBezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const cx = 3 * x1,
    bx = 3 * (x2 - x1) - cx,
    ax = 1 - cx - bx;
  const cy = 3 * y1,
    by = 3 * (y2 - y1) - cy,
    ay = 1 - cy - by;
  const x = (u: number) => ((ax * u + bx) * u + cx) * u;
  const y = (u: number) => ((ay * u + by) * u + cy) * u;
  const dx = (u: number) => (3 * ax * u + 2 * bx) * u + cx;
  return (t) => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    let u = t;
    for (let i = 0; i < 8; i++) {
      const err = x(u) - t;
      if (Math.abs(err) < 1e-7) return y(u);
      const slope = dx(u);
      if (Math.abs(slope) < 1e-7) break;
      u -= err / slope;
    }
    let lo = 0,
      hi = 1;
    u = t;
    for (let i = 0; i < 48 && hi - lo > 1e-9; i++) {
      if (x(u) < t) lo = u;
      else hi = u;
      u = (lo + hi) / 2;
    }
    return y(u);
  };
}

// The named curves, measured frame by frame off a reference launch film and
// confirmed against the curves its source declares.
const SNAP = cubicBezier(0.16, 1, 0.3, 1); // arrivals: ~90 % of the travel in the first third
const SWIFT = cubicBezier(0.22, 1, 0.36, 1); // an object moving
const GLIDE = cubicBezier(0.65, 0, 0.35, 1); // a camera or a hand: symmetric, no overshoot

// A landing: a damped spring (ζ 0.6 → ≈9.5 % overshoot, ≈1 % undershoot)
// stiff enough to settle by the keyframe — over 0.6 s it peaks at 0.23 s and
// is still at 0.6 s, the reference film's tile landing. The residual left at
// the keyframe (≈0.05 %) is blended out so the keyframe value is exact.
const SPRING_ZETA = 0.6;
const SPRING_W = Math.log(500) / SPRING_ZETA; // envelope 1/500 at the keyframe
const SPRING_WD = SPRING_W * Math.sqrt(1 - SPRING_ZETA ** 2);
const springResidual = (u: number) =>
  Math.exp(-SPRING_ZETA * SPRING_W * u) *
  (Math.cos(SPRING_WD * u) + ((SPRING_ZETA * SPRING_W) / SPRING_WD) * Math.sin(SPRING_WD * u));
const SPRING_END = springResidual(1);

/** Progress 0→1 along a keyframe segment; `spring` and `back` pass 1 on the way. */
export function motionEase(t: number, easing: MotionEasing = "linear"): number {
  const p = clamp(t);
  // the ends are exact for every curve (floating point would leave 2e-16)
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  switch (easing) {
    case "ease-in":
      return p ** 3;
    case "ease-out":
      return 1 - (1 - p) ** 3;
    case "ease-in-out":
      return p < 0.5 ? 4 * p ** 3 : 1 - (-2 * p + 2) ** 3 / 2;
    case "step":
      return p < 1 ? 0 : 1;
    case "snap":
      return SNAP(p);
    case "swift":
      return SWIFT(p);
    case "glide":
      return GLIDE(p);
    case "spring":
      return 1 - springResidual(p) + SPRING_END * p ** 3;
    case "back": {
      const s = 1.70158;
      return 1 + (s + 1) * (p - 1) ** 3 + s * (p - 1) ** 2;
    }
    default:
      return p;
  }
}
const ease = motionEase;
export function evaluateMotionTrack(track: MotionTrack, localS: number): number | string {
  const frames = track.keyframes;
  if (localS <= frames[0]!.atS) return frames[0]!.value;
  for (let i = 1; i < frames.length; i++) {
    const to = frames[i]!,
      from = frames[i - 1]!;
    if (localS > to.atS) continue;
    const p = ease((localS - from.atS) / (to.atS - from.atS), to.easing);
    if (p === 0) return from.value;
    if (p === 1) return to.value;
    if (typeof from.value === "number" && typeof to.value === "number")
      return from.value + (to.value - from.value) * p;
    const a = parseMotionColor(from.value)!,
      b = parseMotionColor(to.value)!;
    // an overshooting curve must not push a colour out of gamut
    const c = clamp(p);
    const rgba = a.map((n, j) => n + (b[j]! - n) * c);
    return `rgba(${rgba
      .slice(0, 3)
      .map((n) => Number(n.toFixed(4)))
      .join(",")},${Number(rgba[3]!.toFixed(6))})`;
  }
  return frames.at(-1)!.value;
}
/** The source second a video layer shows at scene-local `localS`. */
export function motionMediaTimeS(
  layer: { trimStartS?: number; startS?: number; durationS: number },
  localS: number,
): number {
  return (
    (layer.trimStartS ?? 0) + Math.max(0, Math.min(layer.durationS, localS - (layer.startS ?? 0)))
  );
}

const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
export function motionGraphemes(text: string): string[] {
  return Array.from(segmenter.segment(text), (part) => part.segment);
}

// ── text units: copy that moves word by word ────────────────────────────────

const wordSegmenter = new Intl.Segmenter(undefined, { granularity: "word" });

/** The copy split into the units a text move animates, per authored line.
 *  Words (CJK included — the segmenter finds its words) or graphemes; spaces
 *  and punctuation ride with the unit before them, so "slides." moves as one. */
export function motionTextUnits(text: string, by: "word" | "grapheme"): string[][] {
  return text.split("\n").map((line) => {
    const parts =
      by === "word"
        ? Array.from(wordSegmenter.segment(line), (s) => s.segment)
        : motionGraphemes(line);
    const units: string[] = [];
    for (const part of parts) {
      const rider = /^\s+$/u.test(part) || (by === "word" && !/[\p{L}\p{N}]/u.test(part));
      if (units.length && rider) units[units.length - 1] += part;
      else units.push(part);
    }
    return units;
  });
}

export type MotionTextSlot = {
  /** the centre of the unit's ink (its copy without the trailing space),
   *  relative to the text box centre, design px */
  cx: number;
  cy: number;
  /** ink width: the unit without its trailing space (the space is only a gap) */
  width: number;
};

/** Where each unit sits: authored lines, wrapped at word boundaries within the
 *  box width, aligned like the whole-box text, top-down at `lineHeight`.
 *  `measure` is the renderer's text measurement for the layer's font. */
export function layoutTextUnits(
  lines: string[][],
  box: { width: number; height: number; align: "left" | "center" | "right"; lineHeight: number },
  measure: (text: string) => number,
): MotionTextSlot[] {
  const rows: { unit: string; width: number; ink: number }[][] = [];
  for (const line of lines) {
    let row: { unit: string; width: number; ink: number }[] = [];
    let used = 0;
    for (const unit of line) {
      const width = measure(unit),
        ink = measure(unit.trimEnd());
      if (row.length && used + ink > box.width) {
        rows.push(row);
        row = [];
        used = 0;
      }
      row.push({ unit, width, ink });
      used += width;
    }
    rows.push(row);
  }
  const slots: MotionTextSlot[] = [];
  rows.forEach((row, r) => {
    const content = row.reduce((s, u, i) => s + (i === row.length - 1 ? u.ink : u.width), 0);
    let x =
      box.align === "left"
        ? 0
        : box.align === "right"
          ? box.width - content
          : (box.width - content) / 2;
    const cy = -box.height / 2 + (r + 0.5) * box.lineHeight;
    for (const u of row) {
      slots.push({ cx: -box.width / 2 + x + u.ink / 2, cy, width: u.ink });
      x += u.width;
    }
  });
  return slots;
}

export type MotionTextUnitState = {
  /** offset from the unit's place, design px */
  dx: number;
  dy: number;
  scale: number;
  /** degrees */
  rotation: number;
  opacity: number;
  /** blur radius, design px */
  blur: number;
  /** clipped at its line box while it rises through it */
  masked: boolean;
};

const MOVES: Record<MotionTextMoveName, { staggerS: number; durationS: number; arrival: boolean }> =
  {
    rise: { staggerS: 0.07, durationS: 0.9, arrival: true },
    pop: { staggerS: 0.05, durationS: 0.35, arrival: true },
    fade: { staggerS: 0.05, durationS: 0.3, arrival: true },
    fall: { staggerS: 0.035, durationS: 0.55, arrival: false },
    "fade-out": { staggerS: 0.035, durationS: 0.3, arrival: false },
  };
export const isTextArrival = (move: MotionTextMoveName): boolean => MOVES[move].arrival;

/** When unit-animated copy is wholly in place (its last unit has arrived) and
 *  when it starts to leave (its first unit's exit). */
export function textUnitsRest(
  text: string,
  units: MotionTextUnits,
): { fromS: number; untilS: number } {
  const count = motionTextUnits(text, units.by).flat().length;
  let fromS = 0,
    untilS = Number.POSITIVE_INFINITY;
  for (const m of units.moves) {
    const d = MOVES[m.move];
    if (d.arrival)
      fromS =
        m.atS + Math.max(0, count - 1) * (m.staggerS ?? d.staggerS) + (m.durationS ?? d.durationS);
    else untilS = Math.min(untilS, m.atS);
  }
  return { fromS, untilS };
}

const AT_REST: MotionTextUnitState = {
  dx: 0,
  dy: 0,
  scale: 1,
  rotation: 0,
  opacity: 1,
  blur: 0,
  masked: false,
};

/** Unit `index`'s state at scene-local `localS`. Before an arrival the unit is
 *  hidden; between moves it rests; after an exit it is gone. The numbers are
 *  the reference film's: a rise travels 1.1 font sizes on `snap` (0.9 s, 70 ms
 *  apart); a fall drops 0.9 font sizes, tips ±5–6° and blurs to 8 px on
 *  `ease-in` (0.55 s, 35 ms apart); a pop settles from 1.18× and 12 px blur. */
/** Height of a unit's mask: its line, but never tighter than the glyphs'
 *  ascent + descent, so descenders are not clipped while a word rises. */
export function textUnitMaskHeight(font: { fontSize: number; lineHeight: number }): number {
  return Math.max(font.lineHeight, 1.2 * font.fontSize);
}

export function evaluateTextUnit(
  units: MotionTextUnits,
  index: number,
  localS: number,
  font: { fontSize: number; lineHeight: number },
): MotionTextUnitState {
  const moves = [...units.moves].sort((a, b) => a.atS - b.atS);
  // start wholly below the mask: half the mask plus the glyphs' half-height
  const rise = textUnitMaskHeight(font) / 2 + 0.6 * font.fontSize;
  let state: MotionTextUnitState = AT_REST;
  const first = moves[0];
  if (first && MOVES[first.move].arrival)
    state =
      first.move === "rise"
        ? { ...AT_REST, dy: rise, opacity: 0, masked: true }
        : { ...AT_REST, opacity: 0 };
  for (const m of moves) {
    const d = MOVES[m.move];
    const start = m.atS + index * (m.staggerS ?? d.staggerS);
    if (localS < start) break;
    const p = clamp((localS - start) / (m.durationS ?? d.durationS));
    switch (m.move) {
      case "rise":
        state = { ...AT_REST, dy: (1 - motionEase(p, "snap")) * rise, masked: p < 1 };
        break;
      case "pop": {
        const e = motionEase(p, "snap");
        state = {
          ...AT_REST,
          scale: 1 + 0.18 * (1 - e),
          blur: 12 * (1 - e),
          opacity: clamp(p / 0.1),
        };
        break;
      }
      case "fade":
        state = { ...AT_REST, opacity: motionEase(p, "ease-out") };
        break;
      case "fall": {
        const q = motionEase(p, "ease-in");
        state = {
          dx: 0,
          dy: 0.9 * font.fontSize * q,
          scale: 1,
          rotation: (index % 2 ? 6 : -5) * q,
          opacity: 1 - q,
          blur: 8 * q,
          masked: false,
        };
        break;
      }
      case "fade-out":
        state = { ...AT_REST, opacity: 1 - motionEase(p, "ease-in") };
        break;
    }
  }
  return state;
}

/** Input must have passed validation. Evaluation is pure and shared by Node and the browser. */
export function evaluateMotionScene(scene: MotionScene, localS: number): EvaluatedMotionScene {
  const evaluate = (layer: MotionLayer): EvaluatedMotionLayer => {
    const { animations, ...authored } = layer;
    const result: Record<string, unknown> = {
      x: 0,
      y: 0,
      opacity: 1,
      scaleX: 1,
      scaleY: 1,
      rotation: 0,
      rotateX: 0,
      rotateY: 0,
      z: 0,
      ...authored,
    };
    if (scene.motion !== "off")
      for (const track of animations ?? [])
        result[track.property] = evaluateMotionTrack(track, localS);
    if (layer.type === "group") {
      result.children = layer.children.map(evaluate);
      result.clip = layer.clip ?? false;
      result.radius ??= 0;
    }
    if (
      layer.type === "rect" ||
      layer.type === "image" ||
      layer.type === "video" ||
      layer.type === "state"
    ) {
      result.radius ??= 0;
      if (layer.shadow) result.shadow = { ...layer.shadow };
    }
    if (layer.type === "rect" || layer.type === "ellipse") result.strokeWidth ??= 0;
    if (layer.type === "line") {
      result.end ??= 1;
      result.strokeWidth ??= 2;
      result.points = layer.points.map((point) => [...point]);
    }
    if (layer.type === "image") {
      result.fit ??= "contain";
      if (layer.crop) result.crop = { ...layer.crop };
    }
    if (layer.type === "state") {
      result.fit ??= "contain";
      if (layer.crop) result.crop = { ...layer.crop };
      if (layer.only) result.only = [...layer.only];
      if (layer.hide) result.hide = [...layer.hide];
    }
    if (layer.type === "video") {
      result.fit ??= "contain";
      result.trimStartS ??= 0;
      result.startS ??= 0;
      result.mediaTimeS = motionMediaTimeS(layer, localS);
    }
    if (layer.type === "wipe") Object.assign(result, wipeProgress(layer, localS));
    if (layer.type === "text") {
      result.fullText = layer.text;
      result.reveal ??= 1;
      result.align ??= "center";
      result.fontWeight ??= 500;
      result.lineHeight = layer.lineHeight ?? (result.fontSize as number) * 1.2;
      const graphemes = motionGraphemes(layer.text);
      result.text = graphemes
        .slice(0, Math.floor(graphemes.length * clamp(result.reveal as number) + 1e-9))
        .join("");
    }
    return result as EvaluatedMotionLayer;
  };
  return {
    designSize: { ...(scene.designSize ?? { width: 1920, height: 1080 }) },
    layers: scene.layers.map(evaluate),
  };
}

/** open-take's arrow cursor, tip at (0, 0), in arrow units — the take
 *  renderer's shape (scene/scene.tsx) — and its size in design px per unit
 *  (the take's default cursor scale). */
export const CURSOR_ARROW: readonly (readonly [number, number])[] = [
  [0, 0],
  [0, 17],
  [4.5, 13],
  [7.5, 19.5],
  [10, 18.3],
  [7, 11.7],
  [12, 11.7],
];
export const CURSOR_UNIT = 2;
/** The drop shadow's offset, design px (as the take renderer draws it). */
export const CURSOR_SHADOW = 2.5;

/** How far the eye sits from the stage for 3D layers, design px — the
 *  reference film's perspective (2600–3600 measured). */
export const DEFAULT_PERSPECTIVE = 2800;

// ── the wipe: a plain cover for a section change ──────────────────────────

const WIPE = { durationS: 0.45, holdS: 0.1, revealS: 0.3 };

/** Where a wipe is at scene-local `localS`: `sweep` 0→1 as its edge crosses
 *  (on `glide`), `cover` 1 while it covers (sweep and hold), easing to 0 as it
 *  clears. */
export function wipeProgress(
  wipe: MotionWipeLayer,
  localS: number,
): { sweep: number; cover: number } {
  const d = wipe.durationS ?? WIPE.durationS,
    hold = wipe.holdS ?? WIPE.holdS,
    reveal = wipe.revealS ?? WIPE.revealS;
  const t = localS - wipe.atS;
  if (t < 0) return { sweep: 0, cover: 0 };
  const sweep = motionEase(t / d, "glide");
  const clearing = (t - d - hold) / reveal;
  return { sweep, cover: clearing <= 0 ? 1 : clearing >= 1 ? 0 : 1 - clearing };
}

export type WipeShape = {
  /** the part of the frame already covered */
  cover: [number, number][];
};

/** A wipe's cover in scene coordinates (origin at the frame centre) for a
 *  frame `width`×`height`: a straight edge sweeping across. Deliberately
 *  plain — the look of a film's transitions is the author's, not a preset's. */
export function wipeShape(
  wipe: Pick<MotionWipeLayer, "direction">,
  sweep: number,
  width: number,
  height: number,
): WipeShape {
  const pad = 40 * (height / 1080);
  const x0 = -width / 2 - pad,
    x1 = width / 2 + pad;
  const edge = x0 + (x1 - x0) * sweep;
  const top = -height / 2 - pad,
    bottom = height / 2 + pad;
  const cover: [number, number][] = [
    [x0, top],
    [edge, top],
    [edge, bottom],
    [x0, bottom],
  ];
  return { cover: wipe.direction === "left" ? cover.map(([x, y]) => [-x, y]) : cover };
}

// ── hits: the frame shakes and flashes on a beat that lands hard ──────────

// smooth value noise in [-1, 1], deterministic per seed
function valueNoise(x: number, seed: number): number {
  const hash = (i: number) => {
    let h = (i * 374761393 + seed * 668265263) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return (((h ^ (h >>> 16)) >>> 0) / 4294967295) * 2 - 1;
  };
  const i = Math.floor(x),
    f = x - i,
    u = f * f * (3 - 2 * f);
  return hash(i) + (hash(i + 1) - hash(i)) * u;
}

/** The frame's shake (design px, degrees) and white flash (0–0.3) at
 *  scene-local `localS`. Measured off a reference film: the shake decays with
 *  τ 0.18 s, ±18 px across, ±14 px up and down, ±0.5°; the flash decays with
 *  τ 45 ms and never passes 30 % white. */
export function evaluateHits(
  hits: readonly MotionHit[] | undefined,
  localS: number,
): { dx: number; dy: number; rotation: number; flash: number } {
  let shake = 0,
    flash = 0;
  for (const h of hits ?? []) {
    const t = localS - h.atS;
    if (t < 0) continue;
    shake += Math.exp(-t / 0.18) * (h.strength ?? 1);
    flash += Math.exp(-t / 0.045) * (h.flash ?? 0);
  }
  if (shake < 1e-4 && flash < 1e-4) return { dx: 0, dy: 0, rotation: 0, flash: 0 };
  return {
    dx: valueNoise(localS * 38, 3) * 18 * shake,
    dy: valueNoise(localS * 41, 7) * 14 * shake,
    rotation: valueNoise(localS * 29, 11) * 0.5 * shake,
    flash: Math.min(0.3, flash * 0.3),
  };
}

/** Visit validated layers in paint order, including nested image assets. */
export function walkMotionLayers(layers: MotionLayer[]): MotionLayer[] {
  return layers.flatMap((layer) =>
    layer.type === "group" ? [layer, ...walkMotionLayers(layer.children)] : [layer],
  );
}
