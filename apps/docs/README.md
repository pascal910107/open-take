# @open-take/docs — the docs

Fumadocs (Next) app. Every page lives under `/docs`, so one domain serves the
Vite landing (apps/web) at `/` and rewrites `/docs/*` here — locally the
landing's dev server proxies `/docs` to this app.

## Run

```sh
pnpm --filter @open-take/docs dev     # http://localhost:4180/docs
pnpm --filter @open-take/docs build
```

## Notes

- Content is MDX under `content/docs/`; sidebar order lives in `meta.json`.
- `/llms.txt` (index) and `/llms-full.txt` (all pages, rendered) are served
  for agents — open-take is agent-native, its docs should be too.
- Brand tokens (iris on deep neutral, Instrument Sans + Geist Mono) are set in
  `app/global.css` over the Fumadocs neutral preset; dark is the default theme.
- Never published to npm (`private: true`, depended on by nothing).

## SEO

This app is served from two hostnames — `open-take.dev/docs/*` through the
landing's rewrite, and its own `open-take-docs.vercel.app` — so the whole setup
is about naming which one counts:

- `metadataBase` is `https://open-take.dev`, and every page sets
  `alternates.canonical` to its `/docs/...` URL. Whichever host answered, the
  page says the real domain is the one to index.
- `app/robots.txt/route.ts` returns `Disallow: /`. It is only ever reached on
  this deployment's own host (the landing serves the root `robots.txt` and
  rewrites nothing at `/`), so it takes the `*.vercel.app` copy — production
  and previews alike — out of the index without touching `open-take.dev/docs`.
  Do **not** express this as an `X-Robots-Tag` header instead: the rewrite
  reaches this app with `Host: open-take-docs.vercel.app`, so a host-matched
  header would be proxied back to the crawler and deindex the real docs.
- `app/docs/sitemap.xml/route.ts` generates the docs half of the sitemap from
  the content tree, so a new `.mdx` is listed the moment it deploys. The
  landing's `/sitemap.xml` is an index that points at it.
- Each page also emits `TechArticle` + `BreadcrumbList` JSON-LD, the latter
  built from the same page tree the sidebar uses.
