# @open-take/web — the site

The marketing page. One static Vite build, no framework: the hero is the
product's camera rebuilt live in WebGL — a miniature app being shot by the same
grammar the engine uses (spring cursor, ground-truth clicks, ~730 ms punch-in,
1.8× slower release), with a running timecode HUD. Everything below it is the
launch-post voice laid out as a call sheet: slates, rulers, production notes.

## Run

```sh
pnpm --filter @open-take/web dev      # local dev
pnpm --filter @open-take/web build    # static site in dist/
```

`private: true` and depended on by nothing — it is never part of the npm
tarball (`pnpm test:package` proves the tarball's contents). Deploy `dist/`
to any static host; no server, no env.

## Deploy (Vercel, two projects off one repo)

1. Project `open-take-docs`: Root Directory `apps/docs` (Next auto-detected).
2. Project for this app: Root Directory `apps/web` (Vite auto-detected) —
   attach the domain here.
3. `vercel.json` here rewrites `/docs/*` + `/llms*.txt` to the docs project's
   `open-take-docs.vercel.app` — if the docs project gets a different name,
   update that hostname. The docs app's `assetPrefix: "/docs"` keeps all its
   assets under the rewritten path (verified end-to-end via the dev proxy).
4. Set Node.js 22.x in both projects' settings.

## Notes

- `public/film/hero-take.mp4` is segment 03 of the launch film — the demo the
  agent delivered, unedited. The root `.gitignore` drops `*.mp4` as render
  artifacts, so `apps/web/.gitignore` re-includes site media explicitly.
- Fonts are the product's own (Instrument Sans + Geist Mono via fontsource),
  and the palette is the editor's deep-neutral + iris, so site and product
  read as one thing.
- The spring curve in the Camera section is plotted from the same
  critically-damped integrator the hero rig runs — not a hand-drawn path.
- Reduced motion: the stage renders one composed mid-punch frame and holds;
  typing and reveals render final states.
