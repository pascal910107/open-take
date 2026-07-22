// prepack: bundle the built editor SPA into the runtime tarball so the
// published `open-take edit` can serve it (resolveEditorDist checks
// packages/runtime/editor-dist FIRST, before the monorepo path).
import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url)); // packages/runtime/scripts
const src = resolve(here, "..", "..", "..", "apps", "editor", "dist");
const dest = resolve(here, "..", "editor-dist");

if (!existsSync(resolve(src, "index.html"))) {
  console.error("bundle-editor: apps/editor/dist missing — run `pnpm build` first");
  process.exit(1);
}
rmSync(dest, { recursive: true, force: true });
cpSync(src, dest, { recursive: true });
console.log(`bundle-editor: ${src} → ${dest}`);
