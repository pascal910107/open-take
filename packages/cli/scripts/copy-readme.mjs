// npm renders the README that sits INSIDE the published package, so the root
// README (which GitHub shows) never reaches npmjs.com on its own — the package
// page comes up empty. Copy it in at build; source of truth stays the repo
// root. Gitignored in packages/cli, same as skill/.
import { copyFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url)); // packages/cli/scripts
const src = resolve(here, "..", "..", "..", "README.md");
const dest = resolve(here, "..", "README.md");
copyFileSync(src, dest);
