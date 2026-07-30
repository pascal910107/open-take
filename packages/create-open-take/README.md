# create-open-take

The initializer for [Open Take][site] — cinematic product demos, recorded by
your agent.

```sh
npm create open-take@latest my-demo   # new project in ./my-demo
npm create open-take@latest           # in your app's root: adds it there
npm create open-take@latest .         # ...or here, explicitly
```

Then ask your agent:

> Make a demo of localhost:3000 for Twitter.

## What it writes

- `open-take`, installed into the directory (plus `package.json`, **only** if
  the directory has none, and a lockfile)
- `.agents/skills/open-take/` and `.claude/skills/open-take/` — the project
  skill, from `open-take init`

The skill is the half that teaches your agent what a good demo *is*: explore the
app first, commit to a shot list, then shoot. That is why this is the documented
entry point and `npm i -g open-take` is not — a global install gives you the CLI
with no skill, so the agent has nothing to plan against.

It runs from an app root (a directory with `package.json`) and installs there.
Anywhere else it asks which directory to create, and never writes into the one
you happen to be standing in without being told to. The closing summary lists
exactly what landed, and says how to undo it.

## Options

```
-y, --yes                                 skip the question, use ./open-take-demo
--use-npm | --use-pnpm | --use-yarn | --use-bun
-h, --help
```

The package manager is detected from the target directory; the flags override
it. Pass them after `--`:

```sh
npm create open-take@latest my-demo -- --use-pnpm
```

## Notes

Requires Node.js 22+. On the first demo, Open Take downloads and caches its own
Chrome for Testing under `~/.open-take/browsers`; later runs reuse it.

This package is versioned independently of `open-take` — it always installs
`open-take@latest`, so its own version number lagging the CLI's is expected.

[Docs][docs] · [GitHub][repo] · MIT.

[site]: https://open-take.dev
[docs]: https://open-take.dev/docs
[repo]: https://github.com/pascal910107/open-take
