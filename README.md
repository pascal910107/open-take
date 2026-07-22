# open-take

Agent-native demo recording. Tell your coding agent to make a demo of
your app or CLI; it drives the real thing and produces a polished,
re-editable video.

**Status:** the pipeline works end-to-end — agent-planned capture (pure CDP),
cinematic compositor (selective zoom, silky cursor, motion blur), and a
conversational refine loop. Not yet published to npm.

## How it works

The agent plans the demo and drives the real product over CDP. Every action it
issues is a ground-truth event (exact coordinates, timing). A compositor turns
that event log into cinematic auto-zoom and a smooth synthetic cursor over the
captured frames. Output: a polished MP4 and an editable composition you refine
**by talking to the agent** — there is no video editor to learn.

## Using it (the refine loop)

Not on npm yet — from a checkout, `pnpm install && pnpm build` links the bin
(`npx open-take …` works from the repo root). Once installed in a project,
`npx open-take skill install` writes the agent guide into `.claude/skills/`
so a coding agent can drive the whole loop; `npx open-take skill` prints it.

```
open-take make   --plan plan.json --out demo.mp4    # capture + polished master
open-take edit   demo.mp4                           # visual editor: drag zoom regions,
                                                    # looks, motion — live preview
open-take render demo.mp4 --review                  # fast draft with beat numbers
                                                    # burned in + REVIEW watermark
open-take beats  demo.mp4 --card                    # the numbered beat sheet
open-take ab     demo.mp4 --set zoom=light,tight --beat 2
                                                    # a taste question as an A/B reel
open-take render demo.mp4 --reveal                  # final master, revealed to post
```

You watch the review copy, give notes in plain language ("beat 3: no zoom",
"look: slate"); the agent edits `demo.composition.json` and re-renders over the
kept capture — deterministic, no app re-drive. Taste questions come back as a
labeled A/B reel (the current state is always variant A, so "A" means keep it);
every re-render keeps the previous master as `demo.prev.mp4`. See
`skills/open-take/SKILL.md` for the full loop.

## Packages

- `cli` — the `open-take` bin: `inspect · make · render · beats · ab · edit · skill`.
- `runtime` — capture (pure CDP: drive + screencast a self-launched Chrome) →
  plan → render; take resolution, review copies, A/B reels.
- `compositor` — event log → editable `TakeComposition` → revideo render;
  validation, presets (zoom levels / looks / pace / finish).
- `core` — take IR, action DSL, adapter interfaces (framework-free).
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
