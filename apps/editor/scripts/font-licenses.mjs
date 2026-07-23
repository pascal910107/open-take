// post-build: the editor bundle embeds Geist Mono + Instrument Sans webfonts
// (vite hashes them into dist/assets). The SIL Open Font License requires the
// copyright notice and the license text to travel WITH the font files — and
// these assets travel far: dist/ is copied into the runtime tarball as
// editor-dist/ (packages/runtime/scripts/bundle-editor.mjs) and published to
// npm. So emit the licenses next to the fonts, generated from the installed
// packages rather than hand-copied, so a font bump can't silently drift.
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url)); // apps/editor/scripts
const editorRoot = resolve(here, "..");
const assets = resolve(editorRoot, "dist", "assets");
const require = createRequire(`${editorRoot}/`);

/** Font packages whose files vite may inline into the bundle. */
const FONTS = ["@fontsource/geist-mono", "@fontsource-variable/instrument-sans"];

if (!existsSync(assets)) {
  console.error("font-licenses: dist/assets missing — run `vite build` first");
  process.exit(1);
}

const sections = [];
for (const name of FONTS) {
  // resolve through the package's own manifest: works under pnpm's symlinked
  // store and survives a version bump (the notice is read, never transcribed).
  const pkgJson = require.resolve(`${name}/package.json`);
  const pkg = JSON.parse(readFileSync(pkgJson, "utf8"));
  const license = resolve(dirname(pkgJson), "LICENSE");
  if (!existsSync(license)) {
    console.error(
      `font-licenses: ${name}@${pkg.version} ships no LICENSE file — refusing to build`,
    );
    process.exit(1);
  }
  sections.push(
    `${"=".repeat(78)}\n${name}@${pkg.version} (${pkg.license})\n${"=".repeat(78)}\n\n${readFileSync(
      license,
      "utf8",
    ).trimEnd()}`,
  );
}

const fontFiles = readdirSync(assets).filter((f) => /\.(woff2?|ttf|otf)$/i.test(f));
const header = `${[
  "Font licenses — open-take editor bundle",
  "",
  "The webfonts in this directory are third-party software, licensed under the",
  "SIL Open Font License 1.1 and redistributed here under its terms. The full",
  "notices follow, one per font family. open-take's own code is MIT (see the",
  "package LICENSE).",
  "",
  `Bundled font files (${fontFiles.length}):`,
  ...fontFiles.map((f) => `  - ${f}`),
].join("\n")}\n\n`;

writeFileSync(resolve(assets, "OFL.txt"), `${header}${sections.join("\n\n")}\n`);
console.log(
  `font-licenses: dist/assets/OFL.txt (${FONTS.length} families, ${fontFiles.length} files)`,
);
