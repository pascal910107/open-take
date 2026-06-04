import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The editor imports the compositor's transform math (math.ts) DIRECTLY from
// source — not a copy — so the browser preview and the revideo renderer share
// the exact same geometry/timing code. This is what retires the "second
// renderer drifts from export" risk: only the cosmetic draw layer (canvas 2D
// vs revideo JSX) is reimplemented; the math is one source of truth.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@compositor": fileURLToPath(new URL("../../packages/compositor/src", import.meta.url)),
    },
  },
  server: {
    // allow Vite to read the compositor source that lives outside this app root
    fs: { allow: [fileURLToPath(new URL("../..", import.meta.url))] },
  },
});
