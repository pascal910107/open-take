import { source } from "@/lib/source";

export const revalidate = false;

/**
 * The docs half of open-take.dev's sitemap index, generated from the content
 * tree so a new .mdx file is in the sitemap the moment it deploys — the web
 * app never has to know how many docs pages exist.
 *
 * Served at /docs/sitemap.xml, which open-take.dev rewrites here alongside
 * every other /docs/* path. Locs are absolute on the real domain, never on
 * the *.vercel.app host this actually runs on.
 */
export function GET() {
  const urls = source
    .getPages()
    .map((page) => `  <url>\n    <loc>https://open-take.dev${page.url}</loc>\n  </url>`)
    .join("\n");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;

  return new Response(xml, {
    headers: { "Content-Type": "application/xml; charset=utf-8" },
  });
}
