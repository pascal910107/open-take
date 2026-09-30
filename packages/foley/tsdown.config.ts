import { defineConfig } from "tsdown";

export default defineConfig({
  // palette.ts is its own entry: the browser-safe half (the editor validates
  // palettes with it; palette-library.ts is the half that reads recordings)
  entry: ["src/index.ts", "src/cli.ts", "src/palette.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
});
