// What `open-take skill …` prints. The film guide is split into a core and
// topic files because a coding agent reads it from stdout, and a print past
// the agent host's inline limit (about 30 KB in Claude Code) comes back as a
// 2 KB preview plus a saved file the session may not be allowed to open (a
// session once saw 200 of the guide's 555 lines that way). Every print except
// `skill film --all` stays well under that, and each starts with the absolute
// paths of the files it came from, so a session can page them with its own
// file reader when stdout is cut anyway.
import { resolve } from "node:path";
import type { SkillBundle } from "./init";

/** The film guide's topics, in the order `skill film --all` prints them. */
export const FILM_TOPICS = [
  "story",
  "craft",
  "tells",
  "material",
  "page",
  "cutting",
  "look",
  "checking",
  "viewer",
  "render",
  "sound",
  "numbers",
] as const;
export type FilmTopic = (typeof FILM_TOPICS)[number];

const FILM_CORE = "references/film.md";
const filmTopicPath = (topic: FilmTopic) => `references/film/${topic}.md`;
/** The core's own list of the topics; `--all` drops it, since they follow. */
const REST_HEADING = /^## The rest of this guide\n[\s\S]*?(?=^## |(?![\s\S]))/m;

const missing = (what: string) => new Error(`${what} not found (re-run the package build)`);

function resource(bundle: SkillBundle, path: string): string {
  const text = bundle.resources?.[path];
  if (text === undefined) throw missing(path);
  return text;
}

export type SkillPrintRequest = {
  /** The positional words after `skill`: [], ["film"], ["film", "material"], … */
  args: string[];
  /** `--all`: with `skill film`, the whole film guide. */
  all?: boolean;
};

/**
 * The text `skill …` prints, from one bundle read from `dir` (whose absolute
 * paths head the film prints). Throws on an unknown word, naming
 * the ones there are.
 */
export function skillPrint(bundle: SkillBundle, dir: string, req: SkillPrintRequest): string {
  const [what, which, ...extra] = req.args;
  const abs = (path: string) => resolve(dir, path);
  if (req.all && what !== "film") throw new Error("skill: --all goes with `skill film`");
  if (extra.length) throw new Error(`skill: unexpected ${extra.join(" ")}`);

  if (what === undefined) return bundle.skillText;

  if (what === "motion") {
    if (which) throw new Error("skill motion: takes no topic");
    return resource(bundle, "references/motion-composition.md");
  }

  if (what === "film") {
    const header = [
      `guide: ${abs(FILM_CORE)}`,
      `topics: ${abs("references/film")}/ (${FILM_TOPICS.map((t) => `${t}.md`).join(", ")})`,
      "",
      "",
    ].join("\n");
    if (which === undefined) {
      const core = resource(bundle, FILM_CORE);
      if (!req.all) return header + core;
      const parts = [core.replace(REST_HEADING, "").trimEnd()];
      for (const topic of FILM_TOPICS) parts.push(resource(bundle, filmTopicPath(topic)).trimEnd());
      return `${header + parts.join("\n\n")}\n`;
    }
    if (req.all) throw new Error("skill film: --all prints every topic — give it no topic");
    const topic = FILM_TOPICS.find((t) => t === which.toLowerCase());
    if (!topic)
      throw new Error(
        `skill film: no topic "${which}" — topics: ${FILM_TOPICS.join(", ")} (or --all)`,
      );
    return [
      `guide: ${abs(filmTopicPath(topic))}`,
      `core: ${abs(FILM_CORE)} (skill film)`,
      "",
      resource(bundle, filmTopicPath(topic)),
    ].join("\n");
  }

  throw new Error("skill: expected motion, film [<topic> | --all] or install [--force]");
}
