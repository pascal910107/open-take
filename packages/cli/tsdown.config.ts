import { defineConfig } from "tsdown";

// Preserve the shebang so dist/cli.js is directly executable.
export default defineConfig({
  entry: ["src/cli.ts"],
  format: ["esm"],
  dts: false,
  clean: true,
});
