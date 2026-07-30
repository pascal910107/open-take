# Contributing

Thanks for looking. This is a small, opinionated project. A bug report with the
video and its `composition.json` attached is worth more than a large PR nobody
asked for — for anything beyond a fix, open an issue first so we agree on the
shape before you build it.

## Setup

Node 22+ and pnpm. The version is pinned in `packageManager`, so Corepack picks
the right one; otherwise install pnpm 10.

```sh
git clone https://github.com/pascal910107/open-take.git
cd open-take
pnpm install
pnpm build
```

Two things `pnpm install` does that are worth knowing about:

- It runs a root `postinstall` (`scripts/fix-node-pty-perms.mjs`) that chmods
  `+x` onto node-pty's `spawn-helper` and the bundled ffmpeg/ffprobe binaries.
  pnpm 10's tarball extraction does not reliably preserve the executable bit,
  and without it capture dies in `posix_spawnp` and renders die with `EACCES`.
  It is idempotent — re-run it whenever an install looks half-applied.
- It does **not** download a browser (`.puppeteerrc.cjs` skips it). Open Take
  fetches its own Chrome for Testing into `~/.open-take/browsers` the first
  time you actually record something.

### ffmpeg

Optional, recommended. `resolveFfmpeg()` prefers `ffmpeg`/`ffprobe` on PATH and
falls back to the bundled `@ffmpeg-installer` / `@ffprobe-installer` binaries,
so the repo works without them. CI installs system ffmpeg, so PATH binaries are
what the gates actually run against.

```sh
brew install ffmpeg        # macOS
sudo apt install ffmpeg    # Debian/Ubuntu
choco install ffmpeg       # Windows
```

## Gates

The exact set CI runs, in order:

```sh
pnpm build
pnpm typecheck
pnpm lint
pnpm -r test
pnpm test:package
```

**`pnpm test` at the root runs nothing.** There is no root `test` script and
turbo has no `test` task, so it prints nothing and exits 0. Tests live per
package — `pnpm -r test` is the one that runs them, and the one CI runs. If you
only ever ran `pnpm test`, you have not run the tests.

Formatting is `pnpm format` (Biome). CI lints but does not check formatting; run
it anyway so diffs stay about the change.

### The render smoke test

`packages/compositor/e2e/render-smoke.test.ts` drives a real Chrome through a
half-second render. It is not part of `pnpm -r test`, and it **fails** rather
than skips when no browser is pointed at it:

```sh
# Linux
OPEN_TAKE_E2E_CHROME="$(command -v google-chrome || command -v chromium)" \
  pnpm --filter @open-take/compositor test:render-smoke

# macOS
OPEN_TAKE_E2E_CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  pnpm --filter @open-take/compositor test:render-smoke
```

CI runs it on Linux only. Worth running locally for anything that touches
rendering.

## The repo

One pnpm workspace. `packages/*` publish to npm, `apps/*` do not.

| path | what |
| --- | --- |
| `packages/cli` | the `open-take` binary — the published CLI and the verbs the agent calls |
| `packages/runtime` | plan → capture (event log) → compositor → mp4; also the `edit` bridge server |
| `packages/compositor` | the polish compositor — event log + frames → mp4 + editable composition |
| `packages/revideo-renderer` | Revideo renderer bridge over puppeteer-core, using the Chrome we manage |
| `packages/create-open-take` | `npm create open-take` — the initializer |
| `packages/adapter-*` | dormant, retained for future audio/terminal work |
| `apps/editor` | Editor v4 — the GUI door, bundled into the `runtime` tarball at prepack |
| `apps/web` | the landing site (Vite + vanilla three.js) |
| `apps/docs` | the docs (Fumadocs/Next) |
| `skills/open-take` | `SKILL.md` — the agent-facing instructions, copied into the CLI tarball at build |

CI covers Linux and Windows. macOS is what the project is developed on but is
not gated, so cross-platform path handling deserves a second look — use
`fileURLToPath()`, never `URL.pathname` (on Windows the latter yields
`/C:/Users/…` and every `fs` call then silently misses).

## Versioning and releases

Maintainer-only, and deliberately not Changesets. `open-take`,
`@open-take/runtime`, `@open-take/compositor` and `@open-take/revideo-renderer`
ship in lockstep on one version number; `create-open-take` moves independently.
`pnpm release` bumps the chain, runs the gates, commits, tags and pushes, and
the `v*` tag triggers `.github/workflows/release.yml`, which publishes over npm
Trusted Publishing (OIDC). There is no npm token anywhere in this repo.

**Do not bump versions in a PR.** The release script owns every `version` field.

## Sending a PR

- Branch off `main`; one concern per PR.
- Run the gates above before pushing.
- Put the user-visible change in the PR **title** — release notes are generated
  from titles, so "fix zoom drifting on short beats" beats "fix bug".
- If you changed what ends up in a published tarball, say so; `pnpm test:package`
  asserts the packed file lists.

### Things to open an issue about before writing code

- **Motion and feel** — zoom curves, spring constants, motion blur, pacing.
  These are settled by watching a rendered A/B with one knob changed, not by a
  metric. Bring a clip.
- **The take layout on disk** (`demo.mp4` + `demo.take/`) or the shape of
  `composition.json`. Both are published formats that other people's files are
  already in.
- **New dependencies in a published package.** The tarballs are deliberately
  small and the dependency tree is deliberately boring.
- **i18n for the editor.** The editor UI is English-only on purpose — the
  rationale is at the bottom of `apps/editor/README.md`. The other door, the
  agent conversation, already speaks the user's language.

## Reporting bugs

Use the issue templates — they ask for the version, OS and ffmpeg build because
that is what the first reply would otherwise ask for. If the video rendered but
looked wrong, attach `demo.take/composition.json`; that plus the clip is usually
enough to reproduce without your app.

Security issues do not go in the issue tracker — see [SECURITY.md](SECURITY.md).
