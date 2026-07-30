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
