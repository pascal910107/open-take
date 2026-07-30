# open-take

Tell your coding agent to make a demo of your app. It drives the real thing and
returns a polished MP4 with a smooth cursor and cinematic zoom, plus an editable
composition you refine by asking your agent for changes in plain language.

## Start

```sh
npm create open-take@latest my-demo   # new project in ./my-demo
npm create open-take@latest           # in your app's root: adds it there
```

Then ask your agent:

> Make a demo of localhost:3000 for Twitter.

The initializer adds Open Take and its project skill — `package.json` (only if
the directory has none), `node_modules/`, and `.agents/skills/open-take/` plus
`.claude/skills/open-take/`; it lists what it wrote when it finishes. Outside an
app root it asks which directory to create rather than writing into the one you
are standing in. On the first demo, Open Take downloads and caches its own
Chrome for Testing under `~/.open-take/browsers`; later runs reuse it.

## What you get

Two things per demo: `demo.mp4` — the one to post — and `demo.take/` beside it,
holding the editable composition, the kept recording, and every draft copy. Post
the mp4; ignore, `.gitignore` (`*.take/`) or delete the folder. Deleting it keeps
the video and gives up re-rendering (the recording is not regenerable).

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
