import { defineConfig } from "tsdown";

// The node-side API, and the HTML renderer's page engine for the browser
// (dist/html-engine.js, served to Chrome at render time). The revideo scene
// (src/scene/**) is NOT bundled — revideo's vite compiles it at render time.
export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["esm"],
    dts: true,
    clean: true,
  },
  {
    // its own directory: the node build cleans dist/ and the two run together
    // film-kit.js: the optional helpers a film page may copy in (`open-take film kit`)
    entry: { "html-engine": "src/html/engine.ts", "film-kit": "src/film/kit-entry.ts" },
    outDir: "dist-browser",
    format: ["esm"],
    platform: "browser",
    dts: false,
    clean: true,
  },
]);
