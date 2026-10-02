import type { LaunchComposition, LaunchIssue, LaunchTheme } from "./launch-types";
import { evaluateMotionTrack, motionGraphemes, parseMotionColor } from "./motion-evaluate";
import type { MotionLayer, MotionScene, MotionTextLayer } from "./motion-types";

/** Heuristic reading time: roughly three words or six CJK/fullwidth glyphs per second.
 * The character-rate floor also accounts for unusually long unbroken words. */
export function estimateMotionReadingSeconds(copy: string, minimum = 0.8): number {
  const glyphs = motionGraphemes(copy);
  const fullwidth =
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Extended_Pictographic}\uFF01-\uFF60]/u;
  let wide = 0;
  const remaining = glyphs
    .map((glyph) => {
      if (!fullwidth.test(glyph)) return glyph;
      wide++;
      return " ";
    })
    .join("");
  const words = remaining.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu)?.length ?? 0;
  const narrow = motionGraphemes(remaining.replace(/\s/g, "")).length;
  return Math.max(minimum, wide / 6 + Math.max(words / 3, narrow / 18));
}

type Matrix = [number, number, number, number, number, number];
type Box = { left: number; top: number; right: number; bottom: number };
type Item = {
  layer: MotionLayer;
  path: string;
  box?: Box;
  matrix: Matrix;
  opacity: number;
  parents: MotionLayer[];
};
const identity: Matrix = [1, 0, 0, 1, 0, 0];
function transform(parent: Matrix, layer: MotionLayer): Matrix {
  const angle = ((layer.rotation ?? 0) * Math.PI) / 180,
    c = Math.cos(angle),
    s = Math.sin(angle),
    sx = layer.scaleX ?? 1,
    sy = layer.scaleY ?? 1;
  const a = c * sx,
    b = s * sx,
    d = -s * sy,
    e = c * sy,
    x = layer.x ?? 0,
    y = layer.y ?? 0;
  return [
    parent[0] * a + parent[2] * b,
    parent[1] * a + parent[3] * b,
    parent[0] * d + parent[2] * e,
    parent[1] * d + parent[3] * e,
    parent[0] * x + parent[2] * y + parent[4],
    parent[1] * x + parent[3] * y + parent[5],
  ];
}
function boxOf(layer: MotionLayer, m: Matrix): Box | undefined {
  const points =
    layer.type === "line"
      ? layer.points
      : "width" in layer &&
          "height" in layer &&
          layer.width !== undefined &&
          layer.height !== undefined
        ? [
            [-layer.width / 2, -layer.height / 2],
            [layer.width / 2, -layer.height / 2],
            [layer.width / 2, layer.height / 2],
            [-layer.width / 2, layer.height / 2],
          ]
        : undefined;
  if (!points) return undefined;
  const x = points.map((p) => m[0] * p[0]! + m[2] * p[1]! + m[4]),
    y = points.map((p) => m[1] * p[0]! + m[3] * p[1]! + m[5]);
  return {
    left: Math.min(...x),
    right: Math.max(...x),
    top: Math.min(...y),
    bottom: Math.max(...y),
  };
}
const intersects = (a: Box, b: Box) =>
  a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
const contains = (a: Box, b: Box) =>
  a.left <= b.left && a.right >= b.right && a.top <= b.top && a.bottom >= b.bottom;
function intersect(a: Box, b: Box): Box {
  return {
    left: Math.max(a.left, b.left),
    right: Math.min(a.right, b.right),
    top: Math.max(a.top, b.top),
    bottom: Math.min(a.bottom, b.bottom),
  };
}
function flatten(scene: MotionScene, prefix: string): Item[] {
  const out: Item[] = [];
  const visit = (
    layers: MotionLayer[],
    path: string,
    parent: Matrix,
    opacity: number,
    parents: MotionLayer[],
    clip?: Box,
  ) => {
    layers.forEach((layer, i) => {
      const matrix = transform(parent, layer),
        nextOpacity = opacity * (layer.opacity ?? 1),
        rawBox = boxOf(layer, matrix),
        box = rawBox && clip ? intersect(rawBox, clip) : rawBox;
      const item = { layer, path: `${path}[${i}]`, matrix, opacity: nextOpacity, parents, box };
      out.push(item);
      if (layer.type === "group")
        visit(
          layer.children,
          `${item.path}.children`,
          matrix,
          nextOpacity,
          [...parents, layer],
          layer.clip && box ? box : clip,
        );
    });
  };
  visit(scene.layers, `${prefix}.layers`, identity, 1, []);
  return out;
}
function trackValue(layer: MotionLayer, property: string, time: number, fallback: number): number {
  const track = layer.animations?.find((x) => x.property === property);
  return track
    ? (evaluateMotionTrack(track, time) as number)
    : ((layer as unknown as Record<string, number>)[property] ?? fallback);
}
type Window = { start: number; end: number };
function commonWindows(left: Window[], right: Window[]): Window[] {
  const result: Window[] = [];
  let i = 0,
    j = 0;
  while (i < left.length && j < right.length) {
    const a = left[i]!,
      b = right[j]!,
      start = Math.max(a.start, b.start),
      end = Math.min(a.end, b.end);
    if (end > start) result.push({ start, end });
    if (a.end <= b.end) i++;
    else j++;
  }
  return result;
}
function usefulHold(scene: MotionScene, item: Item): number {
  if (item.layer.type !== "text") return 0;
  const chain = [...item.parents, item.layer];
  if (scene.motion === "off")
    return (item.layer.reveal ?? 1) >= 0.999 &&
      item.opacity >= 0.5 &&
      Math.hypot(item.matrix[0], item.matrix[1]) > 0.01 &&
      Math.hypot(item.matrix[2], item.matrix[3]) > 0.01
      ? scene.durationS
      : 0;
  const transition =
    scene.transition?.type && scene.transition.type !== "cut"
      ? Math.min(scene.transition.durationS ?? 0.45, scene.durationS / 2)
      : 0;
  const end = scene.durationS - transition;
  let available: Window[] = [{ start: transition, end }];
  for (const layer of chain)
    for (const track of layer.animations ?? []) {
      const stationary: (Window & { value: number | string })[] = [];
      const add = (start: number, finish: number, value: number | string) => {
        const last = stationary.at(-1);
        if (finish <= start) return;
        if (last && last.end === start && last.value === value) last.end = finish;
        else stationary.push({ start, end: finish, value });
      };
      for (let i = 1; i < track.keyframes.length; i++) {
        const from = track.keyframes[i - 1]!,
          to = track.keyframes[i]!;
        if (from.value === to.value || to.easing === "step") add(from.atS, to.atS, from.value);
      }
      const last = track.keyframes.at(-1)!;
      add(last.atS, end, last.value);
      available = commonWindows(available, stationary);
      if (!available.length) return 0;
    }
  let longest = 0;
  for (const window of available) {
    const middle = (window.start + window.end) / 2;
    const visible =
      chain.reduce((opacity, layer) => opacity * trackValue(layer, "opacity", middle, 1), 1) >= 0.5;
    const revealed = trackValue(item.layer, "reveal", middle, 1) >= 0.999;
    const scaled = chain.every(
      (layer) =>
        trackValue(layer, "scaleX", middle, 1) > 0.01 &&
        trackValue(layer, "scaleY", middle, 1) > 0.01,
    );
    if (visible && revealed && scaled) longest = Math.max(longest, window.end - window.start);
  }
  return longest;
}

function luminance(rgb: number[]): number {
  const values = rgb.slice(0, 3).map((x) => {
    const n = x / 255;
    return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
  });
  return values[0]! * 0.2126 + values[1]! * 0.7152 + values[2]! * 0.0722;
}
function textContrast(
  item: Item,
  index: number,
  items: Item[],
  theme: LaunchTheme,
  scene: MotionScene,
): number | undefined {
  if (item.layer.type !== "text" || !item.box || item.opacity < 0.999) return undefined;
  const ink = parseMotionColor(item.layer.fill ?? theme.ink),
    canvas = parseMotionColor(scene.background === "dark" ? theme.dark : theme.canvas);
  if (!ink || ink[3] < 0.999 || !canvas || canvas[3] < 0.999) return undefined;
  let background: number[] | undefined = canvas;
  for (let i = 0; i < index; i++) {
    const prior = items[i]!;
    if (
      prior.layer.type === "group" ||
      !prior.box ||
      prior.opacity < 0.001 ||
      !intersects(prior.box, item.box)
    )
      continue;
    if (
      prior.layer.type !== "rect" ||
      Math.abs(prior.matrix[1]) + Math.abs(prior.matrix[2]) > 1e-6
    ) {
      background = undefined;
      continue;
    }
    const radius =
      (prior.layer.radius ?? 0) * Math.max(Math.abs(prior.matrix[0]), Math.abs(prior.matrix[3]));
    const inner = {
      left: prior.box.left + radius,
      right: prior.box.right - radius,
      top: prior.box.top + radius,
      bottom: prior.box.bottom - radius,
    };
    const paint = parseMotionColor(prior.layer.fill ?? theme.surface);
    if (!contains(inner, item.box) || !paint) {
      background = undefined;
      continue;
    }
    const alpha = paint[3] * prior.opacity;
    if (alpha >= 0.999) background = paint;
    else if (background)
      background = paint.slice(0, 3).map((n, j) => n * alpha + background![j]! * (1 - alpha));
  }
  // A later image or shape can obscure the text: its visible background is uncertain.
  if (
    items
      .slice(index + 1)
      .some(
        (x) =>
          x.layer.type !== "group" && x.box && x.opacity > 0.001 && intersects(x.box, item.box!),
      )
  )
    return undefined;
  if (!background) return undefined;
  const a = luminance(ink),
    b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
function denseAnimation(scene: MotionScene, items: Item[]): number {
  if (scene.motion === "off") return 0;
  const events: { time: number; delta: number; id: string }[] = [];
  for (const item of items)
    for (const track of item.layer.animations ?? [])
      for (let i = 1; i < track.keyframes.length; i++) {
        const a = track.keyframes[i - 1]!,
          b = track.keyframes[i]!;
        if (a.value !== b.value && b.easing !== "step")
          events.push(
            { time: a.atS, delta: 1, id: item.path },
            { time: b.atS, delta: -1, id: item.path },
          );
      }
  events.sort((a, b) => a.time - b.time || a.delta - b.delta);
  const active = new Map<string, number>();
  let peak = 0;
  for (let i = 0; i < events.length; ) {
    const time = events[i]!.time;
    while (i < events.length && events[i]!.time === time) {
      const event = events[i++]!,
        count = (active.get(event.id) ?? 0) + event.delta;
      if (count > 0) active.set(event.id, count);
      else active.delete(event.id);
    }
    if (i < events.length) peak = Math.max(peak, active.size);
  }
  return peak;
}

type Point = [number, number];
type ClipBounds = { inverse: Matrix; halfWidth: number; halfHeight: number };
type SampleItem = Item & { clips: ClipBounds[]; stable: boolean; order: number };
const connectorProperties = new Set([
  "x",
  "y",
  "scaleX",
  "scaleY",
  "rotation",
  "opacity",
  "width",
  "height",
  "radius",
  "end",
  "stroke",
  "strokeWidth",
  "fill",
]);
function pointAt(m: Matrix, p: Point): Point {
  return [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];
}
function clipBounds(
  matrix: Matrix,
  width: number,
  height: number,
  radius = 0,
): ClipBounds | undefined {
  const [a, b, c, d, x, y] = matrix,
    determinant = a * d - b * c;
  if (Math.abs(determinant) < 1e-8) return undefined;
  // An inscribed rectangle avoids claiming visibility in rounded-away corners.
  const inset = Math.min(radius, width / 2, height / 2) * (1 - Math.SQRT1_2) + 0.5;
  if (width / 2 <= inset || height / 2 <= inset) return undefined;
  return {
    inverse: [
      d / determinant,
      -b / determinant,
      -c / determinant,
      a / determinant,
      (c * y - d * x) / determinant,
      (b * x - a * y) / determinant,
    ],
    halfWidth: width / 2 - inset,
    halfHeight: height / 2 - inset,
  };
}
/** Clip the actual segment, not its bounding box, against transformed rectangles. */
function segmentInterval(
  from: Point,
  to: Point,
  bounds: ClipBounds[],
): [number, number] | undefined {
  let low = 0,
    high = 1;
  for (const bound of bounds) {
    const a = pointAt(bound.inverse, from),
      b = pointAt(bound.inverse, to);
    for (const [axis, half] of [
      [0, bound.halfWidth],
      [1, bound.halfHeight],
    ] as const) {
      const delta = b[axis] - a[axis];
      if (Math.abs(delta) < 1e-10) {
        if (Math.abs(a[axis]) >= half) return undefined;
      } else {
        const first = (-half - a[axis]) / delta,
          last = (half - a[axis]) / delta;
        low = Math.max(low, Math.min(first, last));
        high = Math.min(high, Math.max(first, last));
        if (high - low < 1e-7) return undefined;
      }
    }
  }
  return high > low ? [low, high] : undefined;
}
function revealedSegments(
  layer: Extract<MotionLayer, { type: "line" }>,
  matrix: Matrix,
): [Point, Point][] {
  const lengths = layer.points
    .slice(1)
    .map((point, i) => Math.hypot(point[0] - layer.points[i]![0], point[1] - layer.points[i]![1]));
  let remaining = lengths.reduce((a, b) => a + b, 0) * (layer.end ?? 1);
  const segments: [Point, Point][] = [];
  for (let i = 0; i < lengths.length && remaining > 0; i++) {
    const length = lengths[i]!;
    if (!length) continue;
    const from = layer.points[i]!,
      to = layer.points[i + 1]!,
      fraction = Math.min(1, remaining / length);
    segments.push([
      pointAt(matrix, from),
      pointAt(matrix, [
        from[0] + (to[0] - from[0]) * fraction,
        from[1] + (to[1] - from[1]) * fraction,
      ]),
    ]);
    remaining -= length;
  }
  return segments;
}

function connectorWarnings(scene: MotionScene, items: Item[], theme: LaunchTheme): LaunchIssue[] {
  const lines = items.filter((item) => item.layer.type === "line");
  const media = items.filter((item) => item.layer.type === "image" || item.layer.type === "video");
  if (!lines.length || !media.length) return [];
  const relevant = new Set<MotionLayer>();
  for (const item of [...lines, ...media, ...items.filter((x) => x.layer.type === "rect")])
    for (const layer of [...item.parents, item.layer]) relevant.add(layer);
  const transition =
    scene.motion !== "off" && scene.transition?.type && scene.transition.type !== "cut"
      ? Math.min(scene.transition.durationS ?? 0.45, scene.durationS / 2)
      : 0;
  const first = transition,
    last = scene.durationS - transition,
    halfHold = 0.175;
  if (last - first < halfHold * 2) return [];
  // Up to 64 samples and 40k segment comparisons. Dense/short-lived crossings
  // can be missed; this advisory is not an exhaustive visibility certificate.
  const times = Array.from(
    { length: 32 },
    (_, i) => first + halfHold + ((last - first - halfHold * 2) * (i + 0.5)) / 32,
  );
  const keyed: number[] = [];
  let candidates = 0,
    random = 0x51de;
  const consider = (time: number) => {
    if (time < first + halfHold || time > last - halfHold) return;
    candidates++;
    if (keyed.length < 32) keyed.push(time);
    else {
      random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
      const index = random % candidates;
      if (index < 32) keyed[index] = time;
    }
  };
  if (scene.motion !== "off")
    for (const layer of relevant)
      for (const track of layer.animations ?? []) {
        if (!connectorProperties.has(track.property)) continue;
        for (let i = 0; i < track.keyframes.length; i++) {
          const a = track.keyframes[i]!.atS,
            b = track.keyframes[i + 1]?.atS ?? last;
          if (b - a >= halfHold * 2) consider((a + b) / 2);
        }
      }
  times.push(...keyed);
  const warnings: LaunchIssue[] = [],
    warned = new Set<string>();
  const design = scene.designSize ?? { width: 1920, height: 1080 };
  const frame = clipBounds(identity, design.width, design.height)!;
  let budget = 40_000;
  for (const time of [...new Set(times)].sort((a, b) => a - b)) {
    const states = new Map<MotionLayer, SampleItem>();
    for (const [order, item] of items.entries()) {
      if (!relevant.has(item.layer)) continue;
      const layer = { ...item.layer } as MotionLayer;
      let stable = true;
      if (scene.motion !== "off")
        for (const track of layer.animations ?? []) {
          if (!connectorProperties.has(track.property)) continue;
          (layer as unknown as Record<string, unknown>)[track.property] = evaluateMotionTrack(
            track,
            time,
          );
          for (let i = 1; i < track.keyframes.length; i++) {
            const a = track.keyframes[i - 1]!,
              b = track.keyframes[i]!;
            if (a.value === b.value) continue;
            if (b.easing === "step") {
              if (b.atS > time - halfHold && b.atS < time + halfHold) stable = false;
            } else if (a.atS < time + halfHold && b.atS > time - halfHold) stable = false;
          }
        }
      const parent = states.get(item.parents.at(-1)!);
      const matrix = transform(parent?.matrix ?? identity, layer);
      const clips = [...(parent?.clips ?? [frame])];
      if (layer.type === "group" && layer.clip) {
        const bounds = clipBounds(matrix, layer.width!, layer.height!, layer.radius);
        if (bounds) clips.push(bounds);
        else stable = false;
      }
      states.set(item.layer, {
        ...item,
        layer,
        matrix,
        order,
        clips,
        box: boxOf(layer, matrix),
        stable: stable && (parent?.stable ?? true),
        opacity: (parent?.opacity ?? 1) * (layer.opacity ?? 1),
      });
    }
    const sampleMedia = media
      .map((item) => states.get(item.layer)!)
      .filter((x) => x.stable && x.opacity >= 0.5);
    const occluders = [...states.values()].flatMap((item) => {
      if (
        item.layer.type !== "rect" ||
        !item.stable ||
        item.opacity < 0.999 ||
        (parseMotionColor(item.layer.fill ?? theme.surface)?.[3] ?? 0) < 0.999
      )
        return [];
      const bounds = clipBounds(
        item.matrix,
        item.layer.width,
        item.layer.height,
        item.layer.radius,
      );
      return bounds ? [{ order: item.order, bounds: [...item.clips, bounds] }] : [];
    });
    for (const authored of lines) {
      if (warned.has(authored.path)) continue;
      const item = states.get(authored.layer)!;
      if (
        item.layer.type !== "line" ||
        !item.stable ||
        item.opacity < 0.1 ||
        Math.abs(item.matrix[0] * item.matrix[3] - item.matrix[1] * item.matrix[2]) < 1e-8 ||
        (item.layer.strokeWidth ?? 2) <= 0 ||
        item.opacity * (parseMotionColor(item.layer.stroke ?? theme.accent)?.[3] ?? 0) < 0.1
      )
        continue;
      const segments = revealedSegments(item.layer, item.matrix);
      if (!segments.length) continue;
      for (const target of sampleMedia) {
        if (
          target.order >= item.order ||
          !target.box ||
          !item.box ||
          !intersects(item.box, target.box)
        )
          continue;
        if (target.layer.type !== "image" && target.layer.type !== "video") continue;
        const bounds = clipBounds(
          target.matrix,
          target.layer.width,
          target.layer.height,
          target.layer.radius,
        );
        if (!bounds) continue;
        let crossing = false;
        for (const [from, to] of segments) {
          if (--budget < 0) return warnings;
          const hit = segmentInterval(from, to, [...item.clips, ...target.clips, bounds]);
          if (!hit) continue;
          // A known opaque shape painted over either participant can remove
          // this entire intersection. Unknown image alpha is not guessed.
          const hidden = occluders.some((occluder) => {
            if (occluder.order <= target.order) return false;
            const covered = segmentInterval(from, to, occluder.bounds);
            return covered && covered[0] <= hit[0] && covered[1] >= hit[1];
          });
          if (!hidden) {
            crossing = true;
            break;
          }
        }
        if (!crossing) continue;
        warnings.push({
          severity: "warn",
          path: authored.path,
          message: `Possible obscuring or ambiguous connector: foreground line "${item.layer.id}" enters media "${target.layer.id}" bounds at scene-local ${time.toFixed(2)}s during a sampled visible hold. Inspect the actual media and omit or reposition the line if this is not intentional; geometry does not establish text or semantic overlap.`,
        });
        warned.add(authored.path);
        break;
      }
    }
  }
  return warnings;
}

/** Heuristics for validated compositions, not a guarantee of aesthetics or measured font layout. */
export function analyzeMotionQuality(composition: LaunchComposition): LaunchIssue[] {
  const issues: LaunchIssue[] = [];
  const warn = (path: string, message: string) => issues.push({ severity: "warn", path, message });
  composition.scenes.forEach((scene, index) => {
    if (scene.type !== "motion") return;
    const prefix = `scenes[${index}]`,
      design = scene.designSize ?? { width: 1920, height: 1080 },
      short = Math.min(design.width, design.height),
      theme = { ...composition.theme, ...scene.colors };
    const frame = {
        left: -design.width / 2,
        right: design.width / 2,
        top: -design.height / 2,
        bottom: design.height / 2,
      },
      items = flatten(scene, prefix);
    items.forEach((item, i) => {
      if (
        item.layer.type !== "group" &&
        item.box &&
        item.opacity > 0.001 &&
        item.box.left < item.box.right &&
        item.box.top < item.box.bottom &&
        !contains(frame, item.box)
      )
        warn(
          item.path,
          "Resting bounds extend outside the design frame; check the authored base position and size. Entrance keyframes are deliberately excluded.",
        );
      if (item.layer.type !== "text") return;
      const text: MotionTextLayer = item.layer,
        scale = Math.min(
          Math.hypot(item.matrix[0], item.matrix[1]),
          Math.hypot(item.matrix[2], item.matrix[3]),
        );
      if (item.opacity > 0.001 && text.fontSize * scale < short * 0.022)
        warn(
          `${item.path}.fontSize`,
          "Text is small relative to the design's short edge; consider a larger font or a simpler message.",
        );
      const ratio = textContrast(item, i, items, theme, scene);
      if (ratio !== undefined && ratio < 4.5)
        warn(
          `${item.path}.fill`,
          `Text contrast is only ${ratio.toFixed(2)}:1 against a known flat background; aim for at least 4.5:1.`,
        );
      const required = estimateMotionReadingSeconds(text.text),
        hold = usefulHold(scene, item);
      if (hold + 0.001 < required)
        warn(
          `${item.path}.animations`,
          `Text has only ${hold.toFixed(2)}s of stable, fully revealed hold; allow about ${required.toFixed(2)}s for this copy. This reading-time estimate is heuristic.`,
        );
    });
    const density = denseAnimation(scene, items);
    if (density > 8)
      warn(
        `${prefix}.layers`,
        `${density} layers animate simultaneously; stagger or simplify the movement to keep attention on the message.`,
      );
    issues.push(...connectorWarnings(scene, items, theme));
  });
  return issues;
}
