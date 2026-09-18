import { launchSceneDurationS } from "./launch-evaluate";
import type {
  LaunchComposition,
  LaunchIssue,
  LaunchScene,
  LaunchStoryEvidence,
  LaunchStoryRole,
} from "./launch-types";
import { evaluateMotionTrack } from "./motion-evaluate";
import { estimateMotionReadingSeconds } from "./motion-quality";
import type { MotionLayer, MotionScene } from "./motion-types";

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const roles: LaunchStoryRole[] = ["context", "promise", "proof", "payoff", "action"];
type LayerRef = { layer: MotionLayer; parents: MotionLayer[] };
function layerIndex(scene: LaunchScene): Map<string, LayerRef> {
  const result = new Map<string, LayerRef>();
  const visit = (layers: MotionLayer[], parents: MotionLayer[]) => {
    for (const layer of layers) {
      result.set(layer.id, { layer, parents });
      if (layer.type === "group") visit(layer.children, [...parents, layer]);
    }
  };
  if (scene.type === "motion") visit(scene.layers, []);
  return result;
}

/** Validate unknown story JSON. Supply structurally validated scenes to check
 * references and scene-local windows; omission checks the metadata shape only. */
export function validateLaunchStory(
  value: unknown,
  scenes?: readonly LaunchScene[],
): LaunchIssue[] {
  if (value === undefined) return [];
  const issues: LaunchIssue[] = [];
  const error = (path: string, message: string) =>
    issues.push({ severity: "error", path, message });
  if (!record(value)) return [{ severity: "error", path: "story", message: "must be an object" }];
  const fields = (obj: Record<string, unknown>, allowed: string[], path: string) => {
    for (const key of Object.keys(obj))
      if (!allowed.includes(key)) error(`${path}.${key}`, "unsupported story field");
  };
  const text = (v: unknown, path: string, limit: number) => {
    if (typeof v !== "string" || !v.trim() || v.length > limit) {
      error(path, `must be a non-empty string of at most ${limit} characters`);
      return false;
    }
    return true;
  };
  fields(value, ["intent", "audience", "takeaway", "beats"], "story");
  if (
    typeof value.intent !== "string" ||
    !["teaser", "launch", "walkthrough"].includes(value.intent)
  )
    error("story.intent", "must be teaser, launch, or walkthrough");
  text(value.audience, "story.audience", 1000);
  text(value.takeaway, "story.takeaway", 2000);
  if (!Array.isArray(value.beats)) {
    error("story.beats", "must be an array");
    return issues;
  }
  const ids = new Set<string>();
  const byId = scenes && new Map(scenes.map((scene) => [scene.id, scene]));
  const indexes = new Map<string, Map<string, LayerRef>>();
  for (const [i, raw] of value.beats.entries()) {
    const path = `story.beats[${i}]`;
    if (!record(raw)) {
      error(path, "must be an object");
      continue;
    }
    fields(raw, ["id", "sceneId", "startS", "endS", "role", "message", "evidence"], path);
    if (text(raw.id, `${path}.id`, 200)) {
      const id = raw.id as string;
      if (ids.has(id)) error(`${path}.id`, "duplicate story beat id");
      ids.add(id);
    }
    text(raw.sceneId, `${path}.sceneId`, 200);
    const scene = typeof raw.sceneId === "string" ? byId?.get(raw.sceneId) : undefined;
    if (byId && typeof raw.sceneId === "string" && !scene)
      error(`${path}.sceneId`, "does not name a scene in this composition");
    if (typeof raw.role !== "string" || !roles.includes(raw.role as LaunchStoryRole))
      error(`${path}.role`, "must be context, promise, proof, payoff, or action");
    text(raw.message, `${path}.message`, 4000);
    for (const key of ["startS", "endS"])
      if (raw[key] !== undefined && (!finite(raw[key]) || raw[key] < 0))
        error(`${path}.${key}`, "must be finite, nonnegative scene-local seconds");
    const duration = scene ? launchSceneDurationS(scene) : undefined;
    const start = raw.startS === undefined ? 0 : raw.startS;
    const end = raw.endS === undefined ? duration : raw.endS;
    if (finite(start) && finite(end) && end <= start)
      error(`${path}.endS`, "must be after the resolved startS");
    if (duration !== undefined) {
      if (finite(start) && start >= duration)
        error(`${path}.startS`, "must start within the referenced scene");
      if (finite(end) && end > duration + 1e-6)
        error(`${path}.endS`, "extends past the referenced scene; beat times are scene-local");
    }
    if (raw.evidence === undefined) continue;
    if (!Array.isArray(raw.evidence)) {
      error(`${path}.evidence`, "must be an array");
      continue;
    }
    let layers = scene && indexes.get(scene.id);
    if (scene && !layers) {
      layers = layerIndex(scene);
      indexes.set(scene.id, layers);
    }
    for (const [j, entry] of raw.evidence.entries()) {
      const p = `${path}.evidence[${j}]`;
      if (!record(entry)) {
        error(p, "must be an object");
        continue;
      }
      fields(entry, ["kind", "layerId"], p);
      if (
        typeof entry.kind !== "string" ||
        !["recording", "screenshot", "illustration"].includes(entry.kind)
      )
        error(`${p}.kind`, "must be recording, screenshot, or illustration");
      if (entry.layerId !== undefined) text(entry.layerId, `${p}.layerId`, 200);
      if (!scene) continue;
      if (entry.layerId === undefined) {
        if (entry.kind === "screenshot" || (entry.kind === "recording" && scene.type !== "footage"))
          error(
            `${p}.layerId`,
            "must name an image/video layer in the same motion scene; only footage recordings or illustrations may omit layerId",
          );
        continue;
      }
      const target =
        typeof entry.layerId === "string" ? layers?.get(entry.layerId)?.layer : undefined;
      if (!target || (target.type !== "image" && target.type !== "video"))
        error(`${p}.layerId`, "must name an image or video layer in this same motion scene");
      else if (
        (entry.kind === "recording" && target.type !== "video") ||
        (entry.kind === "screenshot" && target.type !== "image")
      )
        error(
          `${p}.kind`,
          `${entry.kind} does not match the referenced ${target.type} layer; recordings require video and screenshots require image`,
        );
    }
  }
  return issues;
}

function maximum(
  layer: MotionLayer,
  property: string,
  fallback: number,
  scene: MotionScene,
  start: number,
  end: number,
): number {
  const track =
    scene.motion !== "off" ? layer.animations?.find((t) => t.property === property) : undefined;
  if (!track) return Number((layer as unknown as Record<string, unknown>)[property] ?? fallback);
  return Math.max(
    Number(evaluateMotionTrack(track, start)),
    Number(evaluateMotionTrack(track, end)),
    ...track.keyframes.filter((f) => f.atS > start && f.atS < end).map((f) => Number(f.value)),
  );
}
/** Proves only zero/near-zero opacity or scale for the complete interval.
 * It does not establish visible pixels, occlusion, framing, or semantic truth. */
function definitelyHidden(ref: LayerRef, scene: MotionScene, start: number, end: number): boolean {
  return [...ref.parents, ref.layer].some(
    (layer) =>
      maximum(layer, "opacity", 1, scene, start, end) <= 0.001 ||
      maximum(layer, "scaleX", 1, scene, start, end) <= 0.001 ||
      maximum(layer, "scaleY", 1, scene, start, end) <= 0.001,
  );
}

/** Editorial heuristics for structurally validated compositions. These are
 * warnings, never an aesthetic score or verification of an evidence claim. */
export function analyzeLaunchStory(composition: LaunchComposition): LaunchIssue[] {
  const story = composition.story;
  if (!story) return [];
  const issues: LaunchIssue[] = [];
  const warn = (path: string, message: string) => issues.push({ severity: "warn", path, message });
  const required: LaunchStoryRole[] =
    story.intent === "teaser"
      ? ["promise"]
      : story.intent === "launch"
        ? ["context", "promise", "action"]
        : ["context", "action"];
  for (const role of required)
    if (!story.beats.some((beat) => beat.role === role))
      warn(
        "story.beats",
        `No ${role} beat is declared for this ${story.intent}. Consider ${role === "promise" ? "stating the main message" : role === "context" ? "orienting the intended audience" : "giving the audience a useful next step"}; intentional omissions are allowed.`,
      );
  const promises = story.beats.filter((beat) => beat.role === "promise");
  if (
    new Set(promises.map((beat) => beat.message.trim().replace(/\s+/g, " ").toLowerCase())).size > 1
  )
    warn(
      "story.beats",
      "Several promise beats declare different messages. Check whether they support one main takeaway or compete for attention; this is an editorial prompt, not a semantic judgment.",
    );
  const scenes = new Map(composition.scenes.map((scene) => [scene.id, scene]));
  const indexes = new Map<string, Map<string, LayerRef>>();
  let actualEvidence = false;
  story.beats.forEach((beat, i) => {
    const scene = scenes.get(beat.sceneId)!;
    const path = `story.beats[${i}]`,
      start = beat.startS ?? 0,
      end = beat.endS ?? launchSceneDurationS(scene);
    const reading = estimateMotionReadingSeconds(beat.message);
    if (end - start + 0.001 < reading)
      warn(
        `${path}.endS`,
        `The ${(end - start).toFixed(2)}s editorial window is shorter than the roughly ${reading.toFixed(2)}s reading estimate for its message. Shorten the intended message or allow more time; this does not assert that the message is on-screen copy.`,
      );
    let layers = indexes.get(scene.id);
    if (!layers) {
      layers = layerIndex(scene);
      indexes.set(scene.id, layers);
    }
    let beatActual = false;
    (beat.evidence ?? []).forEach((evidence: LaunchStoryEvidence, j) => {
      const p = `${path}.evidence[${j}]`,
        ref = evidence.layerId ? layers.get(evidence.layerId) : undefined;
      const hidden = ref && scene.type === "motion" && definitelyHidden(ref, scene, start, end);
      if (hidden)
        warn(
          p,
          "The referenced evidence has zero or near-zero opacity/scale throughout this beat, including its ancestors. It cannot supply visible evidence in this window.",
        );
      if (evidence.kind !== "illustration" && !hidden) beatActual = true;
      if (evidence.kind === "recording" && ref?.layer.type === "video") {
        const activeStart = ref.layer.startS ?? 0,
          activeEnd = activeStart + ref.layer.durationS;
        if (Math.min(end, activeEnd) <= Math.max(start, activeStart))
          warn(
            p,
            "This beat does not overlap the recording layer's active playback span; the renderer holds an endpoint frame here. It may show a real still, but does not demonstrate recorded motion in this window.",
          );
      }
    });
    actualEvidence ||= beatActual;
    if (beat.role === "proof" && !beatActual)
      warn(
        `${path}.evidence`,
        `This ${story.intent} declares a proof beat without potentially visible recording/screenshot evidence. An illustration can explain an idea but is not actual UI proof.`,
      );
  });
  if (story.intent !== "teaser" && !actualEvidence)
    warn(
      "story.beats",
      "No potentially visible recording/screenshot evidence is declared. Add a relevant actual source for the main claim; illustrations do not count as actual UI proof. References alone cannot verify what an asset depicts or whether a claim is true.",
    );
  return issues;
}
