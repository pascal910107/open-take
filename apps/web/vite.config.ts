import { resolve } from "node:path";
import { type Plugin, defineConfig } from "vite";

/**
 * The two faces that render above the fold: the headline (Instrument Sans,
 * latin) and the mono the kicker/HUD/command are set in. Fontsource ships
 * `font-display: swap`, so without a preload the browser only discovers them
 * once the stylesheet has parsed — measured at ~390 ms on broadband — and the
 * headline paints twice: once in the fallback, once in Instrument Sans. LCP is
 * scored on the second paint, so pulling these forward moves the metric, not
 * just the flicker.
 *
 * Only latin, and only the two weights the first screen actually uses —
 * preloading a face that isn't needed immediately costs bandwidth at exactly
 * the moment there is none to spare.
 */
const HERO_FONTS = [
  /^instrument-sans-latin-wght-normal-[\w-]+\.woff2$/,
  /^geist-mono-latin-400-normal-[\w-]+\.woff2$/,
];

function preloadHeroFonts(): Plugin {
  return {
    name: "preload-hero-fonts",
    transformIndexHtml: {
      // post, so the bundle exists and the hashed filenames are known
      order: "post",
      handler(html, ctx) {
        // dev serves fonts straight out of node_modules — nothing to hash
        if (!ctx.bundle) return html;

        const files = Object.keys(ctx.bundle);
        const tags = HERO_FONTS.flatMap((pattern) => {
          const match = files.find((file) => pattern.test(file.split("/").pop() ?? ""));
          if (!match) {
            // a fontsource rename would otherwise silently drop the preload
            this.warn(`no bundled font matched ${pattern} — preload skipped`);
            return [];
          }
          return [
            {
              tag: "link",
              attrs: {
                rel: "preload",
                as: "font",
                type: "font/woff2",
                href: `/${match}`,
                // fonts are always fetched in CORS mode; without this the
                // preload misses and the browser downloads the file twice
                crossorigin: "",
              },
              injectTo: "head-prepend" as const,
            },
          ];
        });

        return { html, tags };
      },
    },
  };
}

export default defineConfig({
  plugins: [preloadHeroFonts()],
  // two real pages, not one app with routes — without this the dev and preview
  // servers rewrite every unknown path to the landing, so /take would render
  // the landing and a genuine 404 would look like a working page
  appType: "mpa",
  server: {
    // local integration with the docs app (apps/docs, `next dev --port 4180`);
    // in production the host rewrites /docs/* to the docs deployment instead
    proxy: { "/docs": "http://localhost:4180" },
  },
  build: {
    target: "es2022",
    rollupOptions: {
      // two pages: the landing, and /take — the watch page the film lives on.
      // They share styles but not scripts; take.ts deliberately pulls in none
      // of the stage, so the watch page never downloads three.js.
      input: {
        main: resolve(import.meta.dirname, "index.html"),
        take: resolve(import.meta.dirname, "take/index.html"),
      },
      // one page, one bundle — three.js dominates the landing either way, and a
      // single request beats a waterfall for a page that animates on first paint
      output: { manualChunks: undefined },
    },
  },
});
