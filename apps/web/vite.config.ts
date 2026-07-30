import { defineConfig } from "vite";

export default defineConfig({
  server: {
    // local integration with the docs app (apps/docs, `next dev --port 4180`);
    // in production the host rewrites /docs/* to the docs deployment instead
    proxy: { "/docs": "http://localhost:4180" },
  },
  build: {
    target: "es2022",
    // one page, one bundle — three.js dominates either way, and a single request
    // beats a waterfall for a landing that animates on first paint
    rollupOptions: { output: { manualChunks: undefined } },
  },
});
