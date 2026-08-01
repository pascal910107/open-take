export const revalidate = false;

/**
 * Only ever reached on this deployment's own host (open-take-docs.vercel.app
 * and its preview URLs) — open-take.dev serves its own robots.txt from the web
 * app and rewrites nothing at the root. So this file's whole job is to keep
 * the *.vercel.app copy of the docs out of the index, where it would otherwise
 * compete with open-take.dev/docs for the same queries. Every page also
 * carries a canonical pointing at open-take.dev; this is the harder stop.
 */
export function GET() {
  return new Response("User-agent: *\nDisallow: /\n", {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
