import { statSync } from "node:fs";
import { extname, resolve } from "node:path";
import type { LaunchIssue } from "./launch-types";
import { motionGraphemes, parseMotionColor, textUnitsRest } from "./motion-evaluate";
import { MOTION_EASINGS, type MotionTextUnits } from "./motion-types";
import { readStateIndex } from "./state-index";

const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const transforms = ["x", "y", "opacity", "scaleX", "scaleY", "rotation", "rotateX", "rotateY", "z"];
const fields: Record<string, string[]> = {
  group: ["children", "width", "height", "clip", "radius", "camera"],
  rect: ["width", "height", "fill", "stroke", "strokeWidth", "radius", "shadow"],
  ellipse: ["width", "height", "fill", "stroke", "strokeWidth"],
  text: [
    "text",
    "width",
    "height",
    "fontSize",
    "fontFamily",
    "fontWeight",
    "fill",
    "align",
    "lineHeight",
    "reveal",
    "units",
  ],
  image: ["asset", "width", "height", "fit", "radius", "crop", "shadow"],
  video: [
    "asset",
    "width",
    "height",
    "fit",
    "radius",
    "trimStartS",
    "startS",
    "durationS",
    "shadow",
    "take",
  ],
  state: ["state", "width", "height", "fit", "radius", "crop", "shadow", "only", "hide"],
  cursor: [],
  line: ["points", "stroke", "strokeWidth", "end"],
  wipe: ["atS", "durationS", "holdS", "revealS", "direction", "color"],
};
const animated = new Set([
  ...transforms,
  "width",
  "height",
  "radius",
  "fill",
  "stroke",
  "strokeWidth",
  "fontSize",
  "reveal",
  "end",
]);
const ranges: Record<string, [number, number]> = {
  x: [-1_000_000, 1_000_000],
  y: [-1_000_000, 1_000_000],
  rotation: [-36000, 36000],
  rotateX: [-36000, 36000],
  rotateY: [-36000, 36000],
  z: [-100_000, 100_000],
  opacity: [0, 1],
  scaleX: [0, 100],
  scaleY: [0, 100],
  reveal: [0, 1],
  end: [0, 1],
  width: [0.001, 32768],
  height: [0.001, 32768],
  radius: [0, 16384],
  strokeWidth: [0, 4096],
  fontSize: [8, 512],
  lineHeight: [8, 4096],
  fontWeight: [100, 1000],
  trimStartS: [0, 86400],
  startS: [0, 86400],
  durationS: [0.001, 86400],
};

/** Structural validation only; media streams, dimensions and clip bounds are probed asynchronously. */
export function validateMotionScene(value: unknown, path = "$", baseDir?: string): LaunchIssue[] {
  const issues: LaunchIssue[] = [];
  const add = (p: string, message: string) => issues.push({ severity: "error", path: p, message });
  if (!record(value)) return [{ severity: "error", path, message: "must be an object" }];
  const rejectUnknown = (obj: Record<string, unknown>, allowed: string[], p: string) => {
    for (const key of Object.keys(obj))
      if (!allowed.includes(key)) add(`${p}.${key}`, "unsupported field");
  };
  const range = (v: unknown, p: string, min: number, max: number) => {
    if (!finite(v) || v < min || v > max) {
      add(p, `must be finite and between ${min} and ${max}`);
      return false;
    }
    return true;
  };
  const numeric = (v: unknown, p: string, key: string) => range(v, p, ...ranges[key]!);
  const text = (v: unknown, p: string, limit: number) => {
    if (typeof v !== "string" || !v.trim() || v.length > limit) {
      add(p, `must be a non-empty string of at most ${limit} characters`);
      return false;
    }
    return true;
  };
  const enumValue = (v: unknown, p: string, choices: string[]) => {
    if (typeof v !== "string" || !choices.includes(v)) add(p, `must be ${choices.join(", ")}`);
  };
  rejectUnknown(
    value,
    [
      "id",
      "type",
      "durationS",
      "transition",
      "background",
      "colors",
      "motion",
      "designSize",
      "perspective",
      "hits",
      "layers",
    ],
    path,
  );
  if (value.perspective !== undefined)
    range(value.perspective, `${path}.perspective`, 100, 100_000);
  if (value.hits !== undefined) {
    if (!Array.isArray(value.hits) || value.hits.length > 64)
      add(`${path}.hits`, "must be an array of at most 64 hits");
    else
      for (const [i, hit] of value.hits.entries()) {
        const h = `${path}.hits[${i}]`;
        if (!record(hit)) {
          add(h, "must be { atS, strength?, flash? }");
          continue;
        }
        rejectUnknown(hit, ["atS", "strength", "flash"], h);
        if (
          !finite(hit.atS) ||
          hit.atS < 0 ||
          (finite(value.durationS) && hit.atS > value.durationS)
        )
          add(`${h}.atS`, "must be finite and inside the scene duration");
        if (hit.strength !== undefined) range(hit.strength, `${h}.strength`, 0, 1);
        if (hit.flash !== undefined) range(hit.flash, `${h}.flash`, 0, 1);
      }
  }
  if (value.type !== "motion") add(`${path}.type`, "must be motion");
  if (!finite(value.durationS) || value.durationS <= 0)
    add(`${path}.durationS`, "must be finite and positive");
  if (value.designSize !== undefined) {
    if (!record(value.designSize)) add(`${path}.designSize`, "must be an object");
    else {
      rejectUnknown(value.designSize, ["width", "height"], `${path}.designSize`);
      for (const key of ["width", "height"])
        range(value.designSize[key], `${path}.designSize.${key}`, 1, 32768);
    }
  }
  const ids = new Set<string>();
  let count = 0,
    videoCount = 0;
  const visit = (rawLayers: unknown, p: string, depth: number): void => {
    if (!Array.isArray(rawLayers)) {
      add(p, "must be an array of layers");
      return;
    }
    for (const [i, raw] of rawLayers.entries()) {
      const q = `${p}[${i}]`;
      if (++count > 256) {
        if (count === 257) add(q, "scene exceeds the 256-layer limit including nested groups");
        return;
      }
      if (!record(raw)) {
        add(q, "must be an object");
        continue;
      }
      const layer = raw;
      if (text(layer.id, `${q}.id`, 200)) {
        const id = layer.id as string;
        if (ids.has(id)) add(`${q}.id`, `duplicate layer id ${JSON.stringify(id)}`);
        ids.add(id);
      }
      if (typeof layer.type !== "string" || !Object.hasOwn(fields, layer.type)) {
        add(`${q}.type`, "unsupported layer type");
        continue;
      }
      const kind = layer.type,
        own = fields[kind]!;
      if (kind === "video" && ++videoCount > 8 && videoCount === 9)
        add(q, "scene exceeds the 8-video layer limit including nested groups");
      rejectUnknown(layer, ["id", "type", "animations", ...transforms, ...own], q);
      for (const key of [...transforms, ...own]) {
        if (ranges[key] && layer[key] !== undefined) numeric(layer[key], `${q}.${key}`, key);
        if (
          (key === "fill" || key === "stroke") &&
          layer[key] !== undefined &&
          !parseMotionColor(layer[key])
        )
          add(`${q}.${key}`, "must be a valid #RRGGBB/#RRGGBBAA/rgb()/rgba() color");
      }
      const extremes = new Map<string, number[]>();
      for (const key of ["width", "height", "fontSize"])
        if (finite(layer[key])) extremes.set(key, [layer[key]]);
      if (layer.animations !== undefined && !Array.isArray(layer.animations))
        add(`${q}.animations`, "must be an array");
      const seen = new Set<string>();
      for (const [j, track] of (Array.isArray(layer.animations)
        ? layer.animations
        : []
      ).entries()) {
        const a = `${q}.animations[${j}]`;
        if (!record(track)) {
          add(a, "must be an object");
          continue;
        }
        rejectUnknown(track, ["property", "keyframes"], a);
        const property = track.property;
        if (
          typeof property !== "string" ||
          !animated.has(property) ||
          (!transforms.includes(property) && !own.includes(property))
        ) {
          add(`${a}.property`, "unsupported animation property for this layer type");
          continue;
        }
        if (kind === "group" && property === "radius" && layer.clip !== true)
          add(`${a}.property`, "group radius animation requires clip: true");
        if (seen.has(property)) add(`${a}.property`, "only one track per property is allowed");
        seen.add(property);
        if (
          !Array.isArray(track.keyframes) ||
          track.keyframes.length < 1 ||
          track.keyframes.length > (layer.camera === true ? 8192 : 128)
        ) {
          add(
            `${a}.keyframes`,
            layer.camera === true
              ? "must contain between 1 and 8192 keyframes (a camera group's sampled path)"
              : "must contain between 1 and 128 keyframes",
          );
          continue;
        }
        let previous = -1;
        for (const [k, frame] of track.keyframes.entries()) {
          const f = `${a}.keyframes[${k}]`;
          if (!record(frame)) {
            add(f, "must be an object");
            continue;
          }
          rejectUnknown(frame, ["atS", "value", "easing"], f);
          if (
            !finite(frame.atS) ||
            frame.atS < 0 ||
            (finite(value.durationS) && frame.atS > value.durationS)
          )
            add(`${f}.atS`, "must be finite and inside the scene duration");
          else {
            if (k === 0 && frame.atS !== 0) add(`${f}.atS`, "first keyframe must be at 0");
            if (frame.atS <= previous) add(`${f}.atS`, "keyframe times must strictly increase");
            previous = frame.atS;
          }
          if (frame.easing !== undefined)
            enumValue(frame.easing, `${f}.easing`, [...MOTION_EASINGS]);
          if (property === "fill" || property === "stroke") {
            if (!parseMotionColor(frame.value)) add(`${f}.value`, "must be a supported color");
          } else if (
            numeric(frame.value, `${f}.value`, property) &&
            ["width", "height", "fontSize"].includes(property)
          )
            extremes.set(property, [...(extremes.get(property) ?? []), frame.value as number]);
        }
      }
      if (kind === "group") {
        if (layer.camera !== undefined && layer.camera !== true)
          add(`${q}.camera`, "must be true (or absent)");
        if (layer.clip !== undefined && typeof layer.clip !== "boolean")
          add(`${q}.clip`, "must be a boolean");
        if (layer.clip !== true && layer.radius !== undefined)
          add(`${q}.radius`, "group radius requires clip: true");
        if (layer.clip === true)
          for (const key of ["width", "height"])
            if (layer[key] === undefined)
              add(`${q}.${key}`, "clipping requires a positive base dimension");
        if (depth >= 8) add(q, "group nesting exceeds the maximum depth of 8");
        else visit(layer.children, `${q}.children`, depth + 1);
      } else if (kind === "line") {
        if (!Array.isArray(layer.points) || layer.points.length < 2 || layer.points.length > 1024)
          add(`${q}.points`, "must contain between 2 and 1024 coordinate pairs");
        else
          for (const [j, point] of layer.points.entries()) {
            if (!Array.isArray(point) || point.length !== 2)
              add(`${q}.points[${j}]`, "must be an [x,y] pair");
            else
              point.forEach((v, k) => {
                range(v, `${q}.points[${j}][${k}]`, -1_000_000, 1_000_000);
              });
          }
      } else if (kind === "wipe") {
        if (
          !finite(layer.atS) ||
          layer.atS < 0 ||
          (finite(value.durationS) && layer.atS > value.durationS)
        )
          add(`${q}.atS`, "must be finite and inside the scene duration");
        for (const key of ["durationS", "holdS", "revealS"])
          if (layer[key] !== undefined) range(layer[key], `${q}.${key}`, 0.02, 10);
        if (layer.direction !== undefined)
          enumValue(layer.direction, `${q}.direction`, ["right", "left"]);
        if (layer.color !== undefined && !parseMotionColor(layer.color))
          add(`${q}.color`, "must be a valid #RRGGBB/#RRGGBBAA/rgb()/rgba() color");
      } else if (kind !== "cursor") {
        // a cursor is the program's arrow: its size is fixed (scale it)
        for (const key of ["width", "height"])
          if (layer[key] === undefined) add(`${q}.${key}`, "is required and must be positive");
      }
      if (kind === "text" && layer.units !== undefined) {
        const u = `${q}.units`;
        const units = layer.units;
        if (!record(units)) add(u, "must be { by, moves }");
        else {
          rejectUnknown(units, ["by", "moves"], u);
          enumValue(units.by, `${u}.by`, ["word", "grapheme"]);
          if (!Array.isArray(units.moves) || units.moves.length < 1 || units.moves.length > 2)
            add(
              `${u}.moves`,
              "must list one or two moves: an arrival, an exit, or an arrival then an exit",
            );
          else {
            const names: string[] = [];
            let previous = -1;
            for (const [j, m] of units.moves.entries()) {
              const f = `${u}.moves[${j}]`;
              if (!record(m)) {
                add(f, "must be { move, atS, staggerS?, durationS? }");
                continue;
              }
              rejectUnknown(m, ["move", "atS", "staggerS", "durationS"], f);
              const moves = ["rise", "pop", "fade", "fall", "fade-out"];
              enumValue(m.move, `${f}.move`, moves);
              if (typeof m.move === "string" && moves.includes(m.move)) names.push(m.move);
              if (
                !finite(m.atS) ||
                m.atS < 0 ||
                (finite(value.durationS) && m.atS > value.durationS)
              )
                add(`${f}.atS`, "must be finite and inside the scene duration");
              else {
                if (m.atS <= previous) add(`${f}.atS`, "moves must be in time order");
                previous = m.atS;
              }
              if (
                m.staggerS !== undefined &&
                (!finite(m.staggerS) || m.staggerS < 0 || m.staggerS > 1)
              )
                add(`${f}.staggerS`, "must be between 0 and 1 second");
              if (
                m.durationS !== undefined &&
                (!finite(m.durationS) || m.durationS <= 0 || m.durationS > 5)
              )
                add(`${f}.durationS`, "must be above 0 and at most 5 seconds");
            }
            const arrival = (n: string) => n === "rise" || n === "pop" || n === "fade";
            if (names.length === 2 && !(arrival(names[0]!) && !arrival(names[1]!)))
              add(
                `${u}.moves`,
                "two moves must be an arrival (rise, pop, fade) then an exit (fall, fade-out)",
              );
            else if (
              names.length === 2 &&
              typeof layer.text === "string" &&
              (units.by === "word" || units.by === "grapheme") &&
              units.moves.every((m) => record(m) && finite(m.atS))
            ) {
              // a unit still arriving would jump straight into its exit
              const rest = textUnitsRest(layer.text, units as unknown as MotionTextUnits);
              if (rest.untilS < rest.fromS - 1e-6)
                add(
                  `${u}.moves[1].atS`,
                  `the exit starts before the last unit has arrived (${rest.fromS.toFixed(2)}s); start it then or later`,
                );
            }
          }
        }
        if (
          Array.isArray(layer.animations) &&
          layer.animations.some((t) => record(t) && t.property === "reveal")
        )
          add(u, "units animate the copy themselves; drop the reveal track");
      }
      if (kind === "text") {
        const validText = text(layer.text, `${q}.text`, 4000);
        if (layer.fontSize === undefined) add(`${q}.fontSize`, "is required");
        if (layer.fontFamily !== undefined) text(layer.fontFamily, `${q}.fontFamily`, 300);
        if (layer.align !== undefined)
          enumValue(layer.align, `${q}.align`, ["left", "center", "right"]);
        const width = Math.min(...(extremes.get("width") ?? [NaN])),
          height = Math.min(...(extremes.get("height") ?? [NaN])),
          font = Math.max(...(extremes.get("fontSize") ?? [NaN]));
        if (validText && width > 0 && height > 0 && font >= 8) {
          const lineHeight = finite(layer.lineHeight) ? layer.lineHeight : font * 1.2;
          if (lineHeight < font)
            add(`${q}.lineHeight`, "must not be smaller than the largest animated fontSize");
          if (
            estimateMotionTextLines(layer.text as string, width, font) * lineHeight >
            height + 0.001
          )
            add(
              `${q}.text`,
              "copy cannot fit the text box at its narrowest/smallest dimensions and largest fontSize; enlarge the box or shorten the copy",
            );
        }
      }
      if (kind === "image" || kind === "video") {
        if (text(layer.asset, `${q}.asset`, 4096)) {
          const asset = layer.asset as string;
          const extensions =
            kind === "image" ? [".png", ".jpg", ".jpeg", ".webp"] : [".mp4", ".webm", ".mov"];
          if (
            asset.includes("\0") ||
            (/^[a-z][a-z\d+.-]*:/i.test(asset) && !/^[a-z]:[\\/]/i.test(asset))
          )
            add(
              `${q}.asset`,
              kind === "image"
                ? "must be a local PNG/JPEG/WebP path"
                : "must be a local MP4/WebM/MOV path",
            );
          else if (!extensions.includes(extname(asset).toLowerCase()))
            add(
              `${q}.asset`,
              kind === "image"
                ? "only PNG/JPEG/WebP image assets are supported"
                : "only MP4/WebM/MOV video assets are supported",
            );
          else if (baseDir) {
            try {
              if (!statSync(resolve(baseDir, asset)).isFile())
                add(`${q}.asset`, "asset is not a regular file");
            } catch {
              add(`${q}.asset`, `missing asset: ${asset}`);
            }
          }
        }
        if (layer.fit !== undefined) enumValue(layer.fit, `${q}.fit`, ["contain", "cover"]);
        if (kind === "image" && layer.crop !== undefined) {
          if (!record(layer.crop)) add(`${q}.crop`, "must be an object");
          else {
            rejectUnknown(layer.crop, ["x", "y", "width", "height"], `${q}.crop`);
            for (const key of ["x", "y", "width", "height"]) {
              range(layer.crop[key], `${q}.crop.${key}`, key === "x" || key === "y" ? 0 : 1, 32768);
              if (finite(layer.crop[key]) && !Number.isInteger(layer.crop[key]))
                add(`${q}.crop.${key}`, "must be an integer source-pixel coordinate or size");
            }
          }
        }
      }
      if (kind === "video") {
        if (layer.durationS === undefined)
          add(`${q}.durationS`, "is required and must be positive");
        const start = layer.startS === undefined ? 0 : layer.startS;
        if (finite(start) && finite(value.durationS) && start > value.durationS)
          add(`${q}.startS`, "must be inside the scene duration");
        if (
          finite(start) &&
          finite(layer.durationS) &&
          finite(value.durationS) &&
          start + layer.durationS > value.durationS + 1e-9
        )
          add(
            `${q}.durationS`,
            "video active span (startS + durationS) must stay inside the scene duration",
          );
      }
      if (kind === "state") stateLayer(layer, q);
      if (kind === "rect" || kind === "image" || kind === "video" || kind === "state") {
        if (layer.shadow !== undefined) {
          const shadowPath = `${q}.shadow`;
          if (!record(layer.shadow)) add(shadowPath, "must be an object");
          else {
            rejectUnknown(layer.shadow, ["color", "blur", "offsetX", "offsetY"], shadowPath);
            if (!parseMotionColor(layer.shadow.color))
              add(`${shadowPath}.color`, "must be a valid #RRGGBB/#RRGGBBAA/rgb()/rgba() color");
            range(layer.shadow.blur, `${shadowPath}.blur`, 0, 256);
            for (const key of ["offsetX", "offsetY"])
              if (layer.shadow[key] !== undefined)
                range(layer.shadow[key], `${shadowPath}.${key}`, -512, 512);
          }
        }
      }
    }
  };
  // a saved screen: its folder, and the ids and region it names in it
  function stateLayer(layer: Record<string, unknown>, q: string): void {
    if (layer.fit !== undefined) enumValue(layer.fit, `${q}.fit`, ["contain", "cover"]);
    const crop = layer.crop;
    if (crop !== undefined) {
      if (!record(crop)) add(`${q}.crop`, "must be { x, y, width, height } in page CSS px");
      else {
        rejectUnknown(crop, ["x", "y", "width", "height"], `${q}.crop`);
        for (const key of ["x", "y", "width", "height"])
          range(crop[key], `${q}.crop.${key}`, key === "x" || key === "y" ? 0 : 1, 32768);
      }
    }
    const ids: [string, string][] = [];
    for (const key of ["only", "hide"]) {
      const list = layer[key];
      if (list === undefined) continue;
      if (!Array.isArray(list) || !list.length || list.length > 512) {
        add(`${q}.${key}`, "must be a list of 1–512 element ids from the state's index.json");
        continue;
      }
      for (const [i, id] of list.entries())
        if (typeof id !== "string" || !/^e\d+$/.test(id))
          add(`${q}.${key}[${i}]`, 'must be an element id like "e42"');
        else ids.push([`${q}.${key}[${i}]`, id]);
    }
    if (!text(layer.state, `${q}.state`, 4096)) return;
    const state = layer.state as string;
    if (
      state.includes("\0") ||
      (/^[a-z][a-z\d+.-]*:/i.test(state) && !/^[a-z]:[\\/]/i.test(state))
    ) {
      add(`${q}.state`, "must be a local saved-state folder (<take>.take/states/s3)");
      return;
    }
    if (!baseDir) return;
    const index = readStateIndex(resolve(baseDir, state));
    if (typeof index === "string") {
      add(`${q}.state`, index);
      return;
    }
    const known = new Set(index.elements.map((e) => e.id));
    for (const [p, id] of ids) if (!known.has(id)) add(p, `state ${index.id} has no element ${id}`);
    if (record(crop) && [crop.x, crop.y, crop.width, crop.height].every(finite)) {
      const { w, h } = index.viewport;
      if (
        (crop.x as number) + (crop.width as number) > w + 0.5 ||
        (crop.y as number) + (crop.height as number) > h + 0.5
      )
        add(`${q}.crop`, `must stay inside the page (${w}x${h} CSS px)`);
    }
    if (index.fidelity && !index.fidelity.ok)
      issues.push({
        severity: "warn",
        path: `${q}.state`,
        message: `saved state ${index.id} does not re-render like the recording (PSNR ${index.fidelity.psnr.toFixed(1)} dB, ${(index.fidelity.diffFrac * 100).toFixed(0)}% of pixels differ): compare it with ${state}/live.png by eye, or show the recording instead`,
      });
  }
  if (Array.isArray(value.layers) && !value.layers.length)
    add(`${path}.layers`, "must contain at least one layer");
  visit(value.layers, `${path}.layers`, 0);
  return issues;
}

/** Conservative grapheme-aware wrapping estimate; it never splits a Unicode grapheme. */
export function estimateMotionTextLines(text: string, width: number, fontSize: number): number {
  let lines = 1,
    used = 0;
  for (const grapheme of motionGraphemes(text)) {
    if (grapheme === "\n" || grapheme === "\r\n") {
      lines++;
      used = 0;
      continue;
    }
    const advance =
      fontSize *
      (grapheme.length === 1 && grapheme.charCodeAt(0) <= 255
        ? /[MW@%]/.test(grapheme)
          ? 0.95
          : 0.62
        : 1);
    if (advance > width) return Infinity;
    if (used + advance > width + 0.001) {
      lines++;
      used = 0;
    }
    used += advance;
  }
  return lines;
}
