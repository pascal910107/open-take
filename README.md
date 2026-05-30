# open-take

Agent-native demo recording. Tell your coding agent to make a demo of
your app or CLI; it drives the real thing and produces a polished,
re-editable video.

**Status:** early — foundation only. The core types and the
capture/compose adapters are in place and build green. The polish
compositor and the agent runtime are next.

## How it works (target)

The agent plans the demo and drives the real product — a browser via
CDP, a CLI via a pty. Every action it issues is a ground-truth event
(exact coordinates, timing). A compositor turns that event log into
cinematic auto-zoom and a smooth synthetic cursor over the captured
frames. Output: a polished MP4 and an editable composition you refine
by talking to the agent.

## Packages

- `core` — take IR, action DSL, adapter interfaces (framework-free).
- `runtime` — capture (pure CDP: drive + screencast a self-launched Chrome) →
  plan → render. Per-action ground-truth event log. No agent-browser.
- `adapter-node-pty` — terminal capture → asciinema cast.
- `adapter-ffmpeg` — transcode / mux / concat / zoompan.
- `adapter-elevenlabs` — narration (+ a mock for keyless CI).

## Browser (zero-config)

open-take manages **one** browser for you. On the first `make`, it downloads a
pinned Chrome-for-Testing (via `@puppeteer/browsers`) to `~/.open-take/browsers`
— a one-time fetch, with a progress line — and reuses it on every later run.
The **same** binary drives both capture and the headless render, so there's no
second download. Point `OPEN_TAKE_CHROME` at a Chrome binary to override.

> One caveat for the published package: the renderer (revideo) lists `puppeteer`
> as a transitive dependency, whose installer fetches its *own* Chrome by
> default. open-take never uses that copy (it always launches the CfT above), so
> you can skip the redundant ~150MB download with
> `PUPPETEER_SKIP_DOWNLOAD=true npm install`. (A library can't suppress a
> transitive installer for you — npm/pnpm overrides are root-project-only.)

## Develop

```
pnpm install
pnpm build
pnpm typecheck
```

MIT.
