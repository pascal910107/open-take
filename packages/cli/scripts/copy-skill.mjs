// Bundle the agent skill into the CLI package so an npm consumer's agent can
// discover it: `open-take skill` prints it, `open-take skill install` writes it
// into the consumer project's .claude/skills/. Source of truth stays
// skills/open-take/SKILL.md at the repo root.
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url)); // packages/cli/scripts
const src = resolve(here, "..", "..", "..", "skills", "open-take", "SKILL.md");
const dest = resolve(here, "..", "skill", "SKILL.md");
mkdirSync(dirname(dest), { recursive: true });
copyFileSync(src, dest);
