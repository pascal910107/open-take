import { defineConfig } from "tsdown";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/ir/index.ts",
    "src/dsl/index.ts",
    "src/adapters/index.ts",
  ],
  format: ["esm"],
  dts: true,
  clean: true,
});
