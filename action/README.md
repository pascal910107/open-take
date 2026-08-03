# open-take demo action

**A cinematic demo video on every PR that changes your UI** — recorded,
directed, and rendered by an agent inside your CI. Zero authoring: the agent
reads the diff, explores your **running** app, makes the changed flow the
demo's protagonist, and delivers a ~25s polished cut (synthetic cursor,
click-zooms, motion blur) — postable as-is, not a screen-scrape.

The video lands in the workflow's artifacts with a numbered beat sheet;
optionally a sticky PR comment carries the sheet. The same workflow doubles
as your release ritual: trigger it on `release` and the launch video is
waiting before you write the tweet.

## Quickstart — demo the PRs that touch UI

```yaml
name: demo
on:
  pull_request:
    # the poor-man's UI-diff gate: only run when UI code can have changed —
    # a demo of a dependency bump is a video of nothing
    paths: ["src/**", "app/**", "components/**", "pages/**", "styles/**"]
  release:
    types: [published]
  workflow_dispatch: {}

concurrency:
  group: open-take-${{ github.ref }}
  cancel-in-progress: true

permissions:
  contents: read   # checkout needs this; the demo job gets NO write access

jobs:
  demo:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm ci
      - uses: pascal910107/open-take/action@main   # pin to a tag/SHA in real use
        with:
          url: http://localhost:3000
          start: npm run dev
          out: demos/myapp.mp4
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          version: latest        # pin (>= 0.3.0) in real use
```

That's the whole setup. No script to write, no first take to record — the
first video is the agent's own cut, and the run **refuses to post a bad one**
(see the gates below), so the failure mode is silence plus a log, never
garbage with a green check.

Point `url` at a preview deployment instead of `start` and the job doesn't
even boot the app — Vercel/Netlify previews are already running. Prefer a
`labeled` trigger (`if: github.event.label.name == 'demo'`) if you'd rather
demo on demand; note `labeled` can be fired by triage-permission users.

To let it comment on the PR, add `comment: "true"` and give the job
`permissions: { contents: read, pull-requests: write }`. Steering the
editorial is one input:
`brief: "30s for X/Twitter: the bulk-edit flow is the hero"`.

## How runs get cheaper (and better) over time

Every take leaves a `dossier.md` + `composition.json` beside the video — the
agent's map of your app (verified selectors, seeded content, hazards, the
story it chose). The action caches both, and the next run **re-verifies
instead of re-exploring** (measured locally: ~2 exploration calls instead of
a cold explore). The dossier is per-*app* knowledge, so it compounds even
when the next demo tells a brand-new story.

`actions/cache` is branch-scoped — PRs can only *restore* caches saved on the
base branch. Either run the workflow on `main` too (merges/releases keep the
cache warm — the quickstart above already does), or commit the take dir's
`dossier.md` + `composition.json`.

**Power path (optional):** author a take at your desk with your own agent
(`open-take init`, then "make a demo of localhost:3000"), refine it by eye,
commit the dossier + composition. CI then regenerates *your* approved cut on
every trigger. Nice when the demo is marketing-critical; never required.

## What the run refuses to call success

`open-take ci` exits non-zero — and the comment step posts nothing — unless:

- the polished master exists at exactly `out`,
- **zero planned beats were skipped** (on a PR the UI change *is* the diff; a
  vanished selector must fail the run, not ship a video where the cursor
  glides past dead UI),
- the delivered duration is a plausible demo (5–90s).

The agent is additionally briefed to ship nothing when the app itself is
broken (error overlay, blank page, empty data). A missing demo is a fine CI
outcome; a bad one on a PR is not.

## Security model — read this before adopting

This action runs a **non-deterministic autonomous agent** against your app.
If your app renders user-generated content, the agent is reading hostile
input. The containment, layer by layer:

- **Fork PRs are refused outright.** Running a fork's `dev` script next to
  your API key is exactly how CodeRabbit lost its GitHub App key in the
  Kudelski incident. Fork support needs a hosted backend, not a workaround —
  do not wire this into `pull_request_target`.
- **The agent step holds only `ANTHROPIC_API_KEY`.** No `GITHUB_TOKEN` is
  passed to it; the optional comment step is a separate step whose body is
  built from files, fenced and backtick-stripped — agent-composed markdown
  never reaches the PR.
- **The app process is scrubbed**: `open-take ci` boots your `start` command
  with `ANTHROPIC_*`, `CLAUDE_*`, `GITHUB_TOKEN`, `ACTIONS_*`, `INPUT_*`
  removed from its environment.
- **Navigation is pinned to the app's own origin**
  (`OPEN_TAKE_ALLOWED_ORIGINS`): a hostile string on the page that talks the
  agent into a `navigate` step to an attacker URL becomes a *skipped step*,
  never a request.
- **Credential fields are refused**: in CI mode the capture will not type
  into password/token-smelling inputs, so a plan can never film a secret
  being entered.
- **Tool allowlist, not bypass**: the agent runs with a curated allowlist
  (open-take verbs, file reads/writes, ffmpeg, *read-only* git for
  diff-aware editorial) and an explicit deny list (`curl`, `wget`, `gh`,
  `git push`, WebFetch/WebSearch). The `--skip-permissions` escape hatch
  exists on the CLI; this action never sets it.
- **What you should still do**: don't point it at production or at real user
  data; treat the artifact as visible to anyone with repo read access (it
  defaults to 7-day retention for that reason); pin `version`,
  `claude-code-version`, and the action ref; self-hosted runners are
  unsupported (the agent-driven browser inside your VPC is an SSRF surface).
- **Residual risk, honestly**: prompt-injection resistance is a mitigation,
  not a guarantee — the agent both reads the page's text and *looks at
  frames of it*. The origin pin, tool deny list, scrubbed env, and no-token
  design bound what a successful injection can do (roughly: waste your
  budget, produce a bad video — which the gates then refuse to post).

## Honest expectations

- **Wall-clock on ubuntu-latest (4-core)**: a cold first run ~20–35 min
  end-to-end (agent exploration dominates); dossier-warm runs are
  substantially less. Renders are CPU-only (SwiftShader) — WebGL-heavy apps
  capture at software frame rates.
- **Cost**: ~$0.5–2 per video on the happy path (agent tokens dominate);
  `budget-usd` (default $8) is a hard cap enforced by the agent CLI. The
  `paths` filter above is what keeps no-visual-delta PRs from spending it.
- **The video itself can't be embedded in a PR comment** — GitHub has no API
  for that. v0 gives you the artifact + beat sheet; inline playback needs a
  hosted player (that's the roadmap, not this action).
- Logged-in demos are not supported in CI yet (`open-take auth` is
  interactive by design; a headless credential path is on the roadmap).

## Inputs

See [`action.yml`](./action.yml) — every input is documented inline. The ones
you'll actually set: `url`, `start`, `brief`, `out`, `anthropic-api-key`,
`comment`, and the two version pins.
