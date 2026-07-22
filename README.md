# open-take

Tell your coding agent to make a demo of your app. It drives the real thing,
and you get a polished MP4 — smooth cursor, cinematic zoom — plus an editable
composition you refine by talking.

Because the agent is the one clicking, every action is a ground-truth event
with exact coordinates and timing. The zoom lands on the thing that matters
instead of guessing from pixels.

## Install

```
npm i -D open-take            # or pnpm / yarn / bun
npx open-take skill install   # teaches your agent to drive it
```

Then just ask: *"make a demo of localhost:3000 for Twitter."*

## The loop

```
open-take make   --plan plan.json --out demo.mp4   # capture + polished master
open-take render demo.mp4 --review                 # draft with beat numbers burned in
open-take beats  demo.mp4                          # the numbered beat sheet
open-take ab     demo.mp4 --set zoom=light,tight --beat 2
open-take edit   demo.mp4                          # visual editor, live preview
open-take render demo.mp4 --reveal                 # final master
```

Watch the review copy and give notes in plain language — "beat 3: no zoom",
"look: slate". The agent edits `demo.composition.json` and re-renders over the
video it already captured, so your app is never re-recorded. Taste questions
come back as an A/B reel where the current state is always variant A, so "A"
means keep it. Every re-render saves the previous master as `demo.prev.mp4`.

## Notes

- **Browser:** the first `make` downloads a pinned Chrome-for-Testing to
  `~/.open-take/browsers` and reuses it after that. `OPEN_TAKE_CHROME` overrides.
- **Skip a redundant download:** the renderer's `puppeteer` fetches its own
  Chrome that open-take never uses — install with
  `PUPPETEER_SKIP_DOWNLOAD=true` to save ~150MB.
- **Develop:** `pnpm install && pnpm build`.

MIT.
