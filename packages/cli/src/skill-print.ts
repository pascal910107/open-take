// What `open-take skill …` prints. The film guide is split into a core and
// topic files because a coding agent reads it from stdout, and a print past
// the agent host's inline limit (about 30 KB in Claude Code) comes back as a
// 2 KB preview plus a saved file the session may not be allowed to open — one
// Exp7 session saw 200 of the guide's 555 lines that way. Every print except
// `skill film --all` stays well under that, and each starts with the absolute
// paths of the files it came from, so a session can page them with its own
// file reader when stdout is cut anyway.
import { resolve } from "node:path";
import type { SkillBundle } from "./init";

/** The film guide's topics, in the order `skill film --all` prints them. */
export const FILM_TOPICS = [
  "material",
  "page",
  "cutting",
  "look",
  "checking",
  "render",
  "sound",
  "cases",
  "numbers",
] as const;
export type FilmTopic = (typeof FILM_TOPICS)[number];

const FILM_CORE = "references/film.md";
const filmTopicPath = (topic: FilmTopic) => `references/film/${topic}.md`;
const CASES_DIR = "references/cases";
/** The core's own list of the topics; `--all` drops it, since they follow. */
const REST_HEADING = /^## The rest of this guide\n[\s\S]*?(?=^## |(?![\s\S]))/m;

const missing = (what: string) => new Error(`${what} not found (re-run the package build)`);

function resource(bundle: SkillBundle, path: string): string {
  const text = bundle.resources?.[path];
  if (text === undefined) throw missing(path);
  return text;
}

/** Case names, as `skill cases <name>` takes them: the file name without `.md`. */
export function caseNames(bundle: SkillBundle): string[] {
  return Object.keys(bundle.resources ?? {})
    .filter((p) => p.startsWith(`${CASES_DIR}/`) && p.split("/").length === 3)
    .map((p) => p.slice(CASES_DIR.length + 1, -3))
    .filter((n) => n !== "README")
    .sort();
}

export type SkillPrintRequest = {
  /** The positional words after `skill`: [], ["film"], ["film", "material"], ["cases", "carbon"], … */
  args: string[];
  /** `--all`: with `skill film`, the whole film guide. */
  all?: boolean;
};

/**
 * The text `skill …` prints, from one bundle read from `dir` (whose absolute
 * paths head the film and cases prints). Throws on an unknown word, naming
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
      `cases: ${abs(CASES_DIR)}/`,
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
      `core: ${abs(FILM_CORE)} (skill film) · cases: ${abs(CASES_DIR)}/`,
      "",
      resource(bundle, filmTopicPath(topic)),
    ].join("\n");
  }

  if (what === "cases") {
    const names = caseNames(bundle);
    const header = `cases: ${abs(CASES_DIR)}/ · each case: skill cases <${names.join("|")}>\n\n`;
    if (which === undefined) return header + resource(bundle, `${CASES_DIR}/README.md`);
    const key = which.toLowerCase().replace(/\.md$/, "");
    if (key === "readme") return header + resource(bundle, `${CASES_DIR}/README.md`);
    const name = names.find((n) => n.toLowerCase() === key);
    if (!name)
      throw new Error(`skill cases: no case "${which}" — cases: ${names.join(", ") || "none"}`);
    return `case: ${abs(`${CASES_DIR}/${name}.md`)} · index: skill cases\n\n${resource(bundle, `${CASES_DIR}/${name}.md`)}`;
  }

  throw new Error("skill: expected motion, film [<topic> | --all], cases [<name>] or install [--force]");
}
