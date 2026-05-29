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

## Develop

```
pnpm install
pnpm build
pnpm typecheck
```

MIT.
