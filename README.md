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

Two things per demo, in `demos/`: `myapp.mp4` — the one to post — and
`myapp.take/` beside it, holding the editable composition, the kept recording,
and every draft copy. Post the mp4; ignore, `.gitignore` (`*.take/`) or delete
the folder. Deleting it keeps the video and gives up re-rendering (the recording
is not regenerable). Demos stay in one folder so their videos sit side by side.

## Refine

Watch the review copy and give notes in plain language: “beat 3: no zoom”,
“tighter on beat 2”, or “look: slate”. Your agent re-renders from the saved
capture, so visual changes do not re-record your app.

Requires Node.js 22+. For agent-facing commands, run `npx open-take --help`.

## In CI

The same demo with nobody at the desk: `open-take ci` boots your app, hands
the wheel to a headless agent, and refuses to call the run a success unless
the delivered master passes its proof gates — a missing demo is a fine CI
outcome, a bad one is not. The bundled [GitHub Action][action] wires it to
the pull requests that change your UI, and to releases:

```yaml
- uses: pascal910107/open-take/action@main
  with:
    url: http://localhost:3000
    start: npm run dev
    anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

Read [the action's README][action] before adopting — it carries the security
model (what the agent may and may not touch, why fork PRs are refused) and
honest wall-clock and cost numbers.

## Develop

```sh
pnpm install
pnpm build
pnpm -r test   # `pnpm test` at the root runs nothing
```

Setup, the full gate list, and what to open an issue about before writing code:
[CONTRIBUTING.md][contributing]. Security reports go through [SECURITY.md][security],
not the issue tracker.

<!-- Absolute, because this README is also the one npm serves for the `open-take`
     package, where a relative link would resolve under packages/cli/. -->

[contributing]: https://github.com/pascal910107/open-take/blob/main/CONTRIBUTING.md
[security]: https://github.com/pascal910107/open-take/blob/main/SECURITY.md
[action]: https://github.com/pascal910107/open-take/blob/main/action/README.md

MIT.

[![Support open-take on Ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/pascal18663)
