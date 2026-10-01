// Where the built film-kit.js is (dist-browser/, beside the page engine): the
// file `open-take film kit` copies next to an author's page.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { PKG_ROOT } from "../html/launch";

export function filmKitPath(): string {
  const file = join(PKG_ROOT, "dist-browser", "film-kit.js");
  if (!existsSync(file))
    throw new Error(
      "film kit: dist-browser/film-kit.js is missing — rebuild @open-take/compositor",
    );
  return file;
}
