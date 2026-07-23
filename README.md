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
- **Skip redundant browser artifacts:** open-take passes the same
  Chrome-for-Testing binary to recording and rendering. The renderer's
  transitive `puppeteer` dependency can otherwise download its own Chrome /
  Chrome Headless Shell artifacts at **install** time, which open-take never
  uses. Set the option *before* the install that pulls open-take in.

  ```sh
  # macOS / Linux — one install
  PUPPETEER_SKIP_DOWNLOAD=true npm i -D open-take
  ```

  ```powershell
  # PowerShell — one install
  $env:PUPPETEER_SKIP_DOWNLOAD="true"; npm i -D open-take
  ```

  For a persistent project setting, create `.puppeteerrc.cjs` in the consuming
  project before installing:

  ```js
  module.exports = { skipDownload: true };
  ```

  Already installed? Puppeteer's cache is normally `~/.cache/puppeteer` on
  macOS/Linux and `%USERPROFILE%\.cache\puppeteer` on Windows. It is safe to
  remove only if no other project on the machine relies on it. open-take cannot
  set this on a consumer's behalf because Puppeteer reads configuration from
  the consuming project; see [Puppeteer's configuration guide](https://pptr.dev/guides/configuration).
- **Develop:** `pnpm install && pnpm build`.

MIT.
