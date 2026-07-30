import { createMDX } from "fumadocs-mdx/next";

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  // Everything a docs page needs resolves under /docs — pages AND assets — so
  // one host can serve the landing at / and rewrite /docs/* here, wholesale.
  assetPrefix: "/docs",
  async rewrites() {
    return {
      beforeFiles: [{ source: "/docs/_next/:path*", destination: "/_next/:path*" }],
    };
  },
  async redirects() {
    return [{ source: "/", destination: "/docs", permanent: false }];
  },
};

export default withMDX(config);
