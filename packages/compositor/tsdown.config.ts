import { defineConfig } from "tsdown";

// Bundle the node-side API only. The revideo scene (src/scene/**) is NOT
// bundled — it is compiled by revideo's vite at render time.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
});
