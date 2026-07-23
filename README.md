# open-take

Tell your coding agent to make a demo of your app. It drives the real thing and
returns a polished MP4 with a smooth cursor and cinematic zoom, plus an editable
composition you can refine by talking.

## Start

```sh
npm create open-take@latest
```

Then ask your agent:

> Make a demo of localhost:3000 for Twitter.

The initializer adds Open Take and its project skill. On the first demo, Open
Take downloads and caches its own Chrome for Testing; later runs reuse it.

## Refine

Watch the review copy and give notes in plain language: “beat 3: no zoom”,
“tighter on beat 2”, or “look: slate”. Your agent re-renders from the saved
capture, so visual changes do not re-record your app.

Requires Node.js 22+. For agent-facing commands, run `npx open-take --help`.

## Develop

```sh
pnpm install
pnpm build
```

MIT.
