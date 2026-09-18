import { statSync } from "node:fs";
import { resolve } from "node:path";
import { validateLaunchStory } from "./launch-story";
import type { LaunchIssue, LaunchScene } from "./launch-types";
import { validateMotionScene } from "./motion-validate";

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const number = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const issue = (path: string, message: string): LaunchIssue => ({
  severity: "error",
  path,
  message,
});
const colorKeys = ["canvas", "ink", "surface", "accent", "dark"];
const validColor = (value: unknown): boolean => {
  if (typeof value !== "string") return false;
  if (/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(value)) return true;
  const match = value.match(
    /^(rgb|rgba)\(\s*(\d+(?:\.\d+)?|\.\d+)\s*,\s*(\d+(?:\.\d+)?|\.\d+)\s*,\s*(\d+(?:\.\d+)?|\.\d+)(?:\s*,\s*(\d+(?:\.\d+)?|\.\d+))?\s*\)$/i,
  );
  return (
    !!match &&
    (match[1]!.toLowerCase() === "rgba") === (match[5] !== undefined) &&
    match.slice(2, 5).every((x) => Number(x) <= 255) &&
    (match[5] === undefined || Number(match[5]) <= 1)
  );
};

/** Validate untrusted JSON before any timing/layout evaluator can access it. */
export function validateLaunchComposition(value: unknown, baseDir?: string): LaunchIssue[] {
  const out: LaunchIssue[] = [];
  if (!record(value)) return [issue("$", "must be a JSON object")];
  const add = (path: string, message: string) => out.push(issue(path, message));
  const bounded = (
    v: unknown,
    p: string,
    min: number,
    max = Number.MAX_SAFE_INTEGER,
  ): v is number => {
    if (!number(v) || v < min || v > max) {
      add(p, `must be finite and between ${min} and ${max}`);
      return false;
    }
    return true;
  };
  const text = (v: unknown, p: string, max = 200, empty = false): v is string => {
    if (typeof v !== "string" || (!empty && !v.trim())) {
      add(p, "must be a non-empty string");
      return false;
    }
    if (v.length > max) add(p, `exceeds the readable ${max}-character bound`);
    return true;
  };
  const optionalText = (obj: Record<string, unknown>, key: string, p: string, max: number) => {
    if (obj[key] !== undefined) text(obj[key], `${p}.${key}`, max);
  };
  const enumValue = (v: unknown, p: string, choices: string[]) => {
    if (typeof v !== "string" || !choices.includes(v)) add(p, `must be ${choices.join(", ")}`);
  };
  const theme = (v: unknown, p: string, partial: boolean) => {
    if (!record(v)) {
      add(p, "must be an object");
      return;
    }
    for (const key of colorKeys)
      if ((!partial || v[key] !== undefined) && !validColor(v[key]))
        add(`${p}.${key}`, "must be a valid #RRGGBB/#RRGGBBAA/rgb()/rgba() color");
    if (!partial || v.fontFamily !== undefined) text(v.fontFamily, `${p}.fontFamily`, 300);
  };
  const asset = (v: unknown, p: string) => {
    if (!text(v, p, 4096)) return;
    if (v.includes("\0")) {
      add(p, "must be a local path without NUL characters");
      return;
    }
    if (baseDir) {
      try {
        if (!statSync(resolve(baseDir, v)).isFile()) add(p, `asset is not a regular file: ${v}`);
      } catch {
        add(p, `missing asset: ${v}`);
      }
    }
  };
  if (value.version !== 1) add("version", "must be the supported launch composition version 1");
  const output = record(value.output) ? value.output : {};
  for (const key of ["width", "height"])
    if (bounded(output[key], `output.${key}`, 2, 16384) && output[key] % 2 !== 0)
      add(`output.${key}`, "must be an even integer");
  bounded(output.fps, "output.fps", 1, 120);
  theme(value.theme, "theme", false);
  if (!Array.isArray(value.scenes) || value.scenes.length === 0)
    add("scenes", "must contain at least one scene");
  const scenes: unknown[] = Array.isArray(value.scenes) ? value.scenes : [];
  const ids = new Set<string>(),
    ends = new Map<string, number>();
  let total = 0;
  for (const [i, raw] of scenes.entries()) {
    const p = `scenes[${i}]`;
    if (!record(raw)) {
      add(p, "must be an object");
      continue;
    }
    const scene = raw;
    if (text(scene.id, `${p}.id`, 200)) {
      if (ids.has(scene.id)) add(`${p}.id`, `duplicate id ${JSON.stringify(scene.id)}`);
      ids.add(scene.id);
    }
    enumValue(scene.type, `${p}.type`, ["title", "footage", "ui-morph", "end-card", "motion"]);
    if (scene.background !== undefined)
      enumValue(scene.background, `${p}.background`, ["canvas", "dark"]);
    if (scene.motion !== undefined) enumValue(scene.motion, `${p}.motion`, ["on", "off"]);
    if (scene.colors !== undefined) theme(scene.colors, `${p}.colors`, true);
    let duration = 0;
    if (scene.type !== "ui-morph" || scene.durationS !== undefined) {
      if (bounded(scene.durationS, `${p}.durationS`, Number.MIN_VALUE, 86400))
        duration = scene.durationS;
    }
    if (scene.type === "motion") {
      out.push(...validateMotionScene(scene, p, baseDir));
    } else if (scene.type === "title") {
      const lines: unknown[] = Array.isArray(scene.lines) ? scene.lines : [];
      if (!lines.length || lines.length > 6)
        add(`${p}.lines`, "must contain between 1 and 6 non-empty string lines");
      for (const [j, line] of lines.entries())
        if (
          text(line, `${p}.lines[${j}]`, 90) &&
          estimatedTextWidth(line, lines.length > 2 ? 92 : 112) > 1760
        )
          add(`${p}.lines[${j}]`, "is too wide for the title region; split it into more lines");
      optionalText(scene, "brand", p, 60);
      if (scene.staggerS !== undefined) bounded(scene.staggerS, `${p}.staggerS`, 0, 86400);
      if (
        scene.motion !== "off" &&
        0.18 +
          Math.max(0, lines.length - 1) * (number(scene.staggerS) ? scene.staggerS : 0.36) +
          0.45 >
          duration
      )
        add(
          `${p}.durationS`,
          "last line cannot finish entering within scene duration; increase duration or set motion to off",
        );
    } else if (scene.type === "footage") {
      asset(scene.asset, `${p}.asset`);
      if (scene.trimStartS !== undefined) bounded(scene.trimStartS, `${p}.trimStartS`, 0);
      if (scene.fit !== undefined) enumValue(scene.fit, `${p}.fit`, ["contain", "cover"]);
      optionalText(scene, "caption", p, 80);
      if (typeof scene.caption === "string" && estimatedTextWidth(scene.caption, 34) > 1720)
        add(`${p}.caption`, "is too wide for the caption region");
      if (scene.frame !== undefined) {
        if (!record(scene.frame)) add(`${p}.frame`, "must be an object");
        else {
          bounded(scene.frame.inset, `${p}.frame.inset`, 0, 500);
          bounded(
            scene.frame.radius,
            `${p}.frame.radius`,
            0,
            number(scene.frame.inset) ? Math.max(0, 540 - scene.frame.inset) : 540,
          );
        }
      }
    } else if (scene.type === "ui-morph") {
      let width = 1100,
        compact = 112,
        expanded = 218,
        radius = 34;
      if (scene.panel !== undefined) {
        if (!record(scene.panel)) add(`${p}.panel`, "must be an object");
        else {
          if (bounded(scene.panel.width, `${p}.panel.width`, 400, 1700)) width = scene.panel.width;
          if (bounded(scene.panel.compactHeight, `${p}.panel.compactHeight`, 112, 680))
            compact = scene.panel.compactHeight;
          if (bounded(scene.panel.expandedHeight, `${p}.panel.expandedHeight`, 180, 680))
            expanded = scene.panel.expandedHeight;
          if (
            bounded(
              scene.panel.radius,
              `${p}.panel.radius`,
              0,
              Math.min(width, compact, expanded) / 2,
            )
          )
            radius = scene.panel.radius;
        }
      }
      optionalText(scene, "eyebrow", p, 60);
      const states: unknown[] = Array.isArray(scene.states) ? scene.states : [];
      if (!states.length) add(`${p}.states`, "must contain at least one state");
      let derived = 0;
      for (const [j, rawState] of states.entries()) {
        const q = `${p}.states[${j}]`;
        if (!record(rawState)) {
          add(q, "must be an object");
          continue;
        }
        const state = rawState;
        enumValue(state.icon, `${q}.icon`, [
          "record",
          "style",
          "refine",
          "camera",
          "spark",
          "target",
        ]);
        text(state.label, `${q}.label`, 24);
        text(state.prompt, `${q}.prompt`, 90, j === 0);
        for (const key of ["transitionS", "typeS", "typeDelayS", "holdS"])
          bounded(
            state[key],
            `${q}.${key}`,
            key === "transitionS" || key === "typeS" ? Number.MIN_VALUE : 0,
            86400,
          );
        if ([state.transitionS, state.typeS, state.typeDelayS, state.holdS].every(number))
          derived +=
            Math.max(
              state.transitionS as number,
              (state.typeDelayS as number) + (state.typeS as number),
            ) + (state.holdS as number);
        if (state.panelWidth !== undefined) bounded(state.panelWidth, `${q}.panelWidth`, 400, 1700);
        if (state.panelHeight !== undefined)
          bounded(
            state.panelHeight,
            `${q}.panelHeight`,
            j === 0 && state.prompt === "" ? 112 : 180,
            680,
          );
        const pw = number(state.panelWidth) ? state.panelWidth : width,
          ph = number(state.panelHeight) ? state.panelHeight : j === 0 ? compact : expanded;
        if (radius > Math.min(pw, ph) / 2)
          add(`${q}.panelHeight`, "panel dimensions must fit the configured corner radius");
        if (typeof state.prompt === "string" && estimatedTextWidth(state.prompt, 46) > pw - 150)
          add(
            `${q}.prompt`,
            `is too wide for its ${pw}px panel; shorten it or increase panelWidth`,
          );
        if (
          typeof state.label === "string" &&
          (132 + state.label.length * 11 > pw - 100 ||
            estimatedTextWidth(state.label, 30) > 50 + state.label.length * 11)
        )
          add(`${q}.label`, "is too wide for its chip; shorten the label");
        if (j === 0 && typeof state.prompt === "string" && state.prompt.trim() && ph < 180)
          add(`${q}.panelHeight`, "a visible prompt needs an expanded panel of at least 180px");
      }
      if (number(scene.durationS) && Math.abs(scene.durationS - derived) > 0.000001)
        add(`${p}.durationS`, `must equal the ${derived.toFixed(3)}s derived from state timings`);
      duration = derived;
    } else if (scene.type === "end-card") {
      text(scene.headline, `${p}.headline`, 110);
      if (scene.motion !== "off" && duration < 1.3)
        add(
          `${p}.durationS`,
          "CTA cannot finish entering before 1.3s; increase duration or set motion to off",
        );
      if (typeof scene.headline === "string") {
        const wrapped: string[] = [];
        for (const authored of scene.headline.split("\n")) {
          let line = "";
          for (const word of authored.split(" ")) {
            if ((line + " " + word).trim().length > 30 && line) {
              wrapped.push(line);
              line = word;
            } else line = (line + " " + word).trim();
          }
          if (line) wrapped.push(line);
        }
        if (wrapped.length > 3 || wrapped.some((line) => estimatedTextWidth(line, 92) > 1760))
          add(
            `${p}.headline`,
            "cannot fit the three-line headline region; shorten copy or add suitable line breaks",
          );
      }
      text(scene.brand, `${p}.brand`, 60);
      text(scene.cta, `${p}.cta`, 100);
      if (typeof scene.cta === "string" && estimatedTextWidth(scene.cta, 28) > 1700)
        add(`${p}.cta`, "is too wide for the CTA region");
      if (
        typeof scene.brand === "string" &&
        estimatedTextWidth(scene.brand, 30) + scene.brand.length * 4 > 1760
      )
        add(`${p}.brand`, "is too wide for the brand region");
    }
    if (scene.transition !== undefined) {
      if (!record(scene.transition)) add(`${p}.transition`, "must be an object");
      else {
        enumValue(scene.transition.type, `${p}.transition.type`, ["cut", "fade", "slide"]);
        if (scene.transition.durationS !== undefined)
          bounded(
            scene.transition.durationS,
            `${p}.transition.durationS`,
            Number.MIN_VALUE,
            duration / 2,
          );
      }
    }
    total += duration;
    if (typeof scene.id === "string") ends.set(scene.id, total);
  }
  if (!Number.isFinite(total) || total > 86400)
    add("scenes", "total duration must be finite and no more than 86400s");
  if (value.audio !== undefined && !Array.isArray(value.audio)) add("audio", "must be an array");
  const audio: unknown[] = Array.isArray(value.audio) ? value.audio : [],
    audioIds = new Set<string>();
  for (const [i, raw] of audio.entries()) {
    const p = `audio[${i}]`;
    if (!record(raw)) {
      add(p, "must be an object");
      continue;
    }
    const track = raw;
    if (text(track.id, `${p}.id`, 200)) {
      if (audioIds.has(track.id)) add(`${p}.id`, "duplicate audio id");
      audioIds.add(track.id);
    }
    enumValue(track.kind, `${p}.kind`, ["music", "narration", "sfx"]);
    asset(track.asset, `${p}.asset`);
    if ((track.atS === undefined) === (track.afterSceneId === undefined))
      add(p, "set exactly one of atS or afterSceneId");
    if (track.atS !== undefined) bounded(track.atS, `${p}.atS`, 0);
    if (
      track.afterSceneId !== undefined &&
      (typeof track.afterSceneId !== "string" || !ends.has(track.afterSceneId))
    )
      add(`${p}.afterSceneId`, "does not name a scene");
    if (track.offsetS !== undefined) {
      bounded(track.offsetS, `${p}.offsetS`, -86400, 86400);
      if (track.atS !== undefined)
        add(`${p}.offsetS`, "requires afterSceneId; use atS for absolute placement");
    }
    for (const key of ["trimStartS", "fadeInS", "fadeOutS", "durationS"])
      if (track[key] !== undefined)
        bounded(track[key], `${p}.${key}`, key === "durationS" ? Number.MIN_VALUE : 0);
    if (track.gain !== undefined) bounded(track.gain, `${p}.gain`, 0, 8);
    for (const key of ["loop", "duckMusic"])
      if (track[key] !== undefined && typeof track[key] !== "boolean")
        add(`${p}.${key}`, "must be a boolean");
    if (track.loop === true && track.kind !== "music")
      add(`${p}.loop`, "is supported only for music");
    if (track.duckMusic === true && track.kind !== "narration")
      add(`${p}.duckMusic`, "is supported only for narration");
    const at = number(track.atS)
      ? track.atS
      : (typeof track.afterSceneId === "string" ? (ends.get(track.afterSceneId) ?? 0) : 0) +
        (number(track.offsetS) ? track.offsetS : 0);
    const duration = number(track.durationS) ? track.durationS : total - at;
    if (at < 0 || at >= total)
      add(`${p}.atS`, "resolved position must be within the composition duration");
    if (at + duration > total + 0.000001)
      add(`${p}.durationS`, "extends past the composition duration");
    const fades =
      (number(track.fadeInS) ? track.fadeInS : 0) + (number(track.fadeOutS) ? track.fadeOutS : 0);
    if (fades > duration)
      add(`${p}.fadeOutS`, "fade-in plus fade-out exceeds the resolved track duration");
  }
  out.push(
    ...validateLaunchStory(
      value.story,
      out.some((item) => item.path.startsWith("scenes")) ? undefined : (scenes as LaunchScene[]),
    ),
  );
  return out;
}

function estimatedTextWidth(text: string, size: number): number {
  let units = 0;
  for (const char of text) units += (char.codePointAt(0) ?? 0) > 255 ? 1 : 0.58;
  return units * size;
}
export function formatLaunchIssues(issues: LaunchIssue[]): string {
  return issues.map((x) => `${x.severity}: ${x.path}: ${x.message}`).join("\n");
}
