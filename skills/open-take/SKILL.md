---
name: open-take
description: Make a polished ~25s demo video of a web app the user names ("make a demo of <url/app> for Twitter"). Explore the app, decide a legible flow, render a cinematic MP4 (smooth synthetic cursor + selective click-zoom) plus an editable composition. Use when the user wants a shareable product demo of a running web app.
---

# open-take — make a demo of an app

You drive a real web app and produce a polished, shareable demo. The
engine already does the cinematic polish (eased synthetic cursor,
bbox-fit click-zoom, framing). **Your job is editorial:** look at the app
and choose a flow that reads well in ~25 seconds.

The honest promise: you produce a strong *draft*. The output includes an
editable composition; the user refines toward "brilliant" by talking.
Don't aim for one-shot perfection — aim for a coherent, legible draft.

## The loop

### 1. Inspect (explore)
```
node packages/cli/dist/cli.js inspect <url> [--viewport 1920x1080]
```
Returns JSON: `{ url, viewport, elements: [{name, tag, role, href, inView, x,y,w,h}] }`.
`name` is the element's accessible name — **target clicks by `name`** (the
`text` locator below). It's stable where CSS selectors are not.

If you need to understand a multi-step flow (what a click reveals), you
can also explore directly with `agent-browser` (open, snapshot, click)
before committing to a plan.

### 2. Decide the flow (the editorial work)
A good demo is **3–5 beats**, ~25s total, with a clear arc:
orient → a couple of meaningful interactions → a strong closer.

**Selective zoom is the signal — do NOT zoom everything.** Set each
click's `zoom`:
- `"never"` — for **global** payoffs (theme/dark-mode toggle, anything
  that changes the whole page) and **navigation** (links to a new page).
  Zooming into the click would hide the payoff. Keep these full-view.
- `"always"` — for **local** payoffs: an interactive control/menu/
  component whose effect appears next to the click (popover, dropdown,
  form result, a small but important button). This is where the cinematic
  zoom earns its place.
- `"auto"` (default) — let the engine's bbox-fit heuristic decide (it
  skips the first/orienting click and elements that already fill the
  frame, and frames the rest).

The first/orienting beat usually should not zoom. Reserve zoom for 1–2
beats; restraint reads as intentional and beats "zoom everything."

### 3. Write the plan (`plan.json`, a TakePlan)
```json
{
  "url": "https://example.com/",
  "viewport": { "width": 1920, "height": 1080 },
  "startCursor": { "x": 300, "y": 950 },
  "steps": [
    { "action": "wait", "ms": 700 },
    { "action": "click", "text": "Toggle theme", "zoom": "never", "note": "flip to dark", "settleMs": 1700 },
    { "action": "click", "text": "Open quick actions", "zoom": "always", "note": "interactive popover", "settleMs": 1600 },
    { "action": "click", "text": "Blocks", "zoom": "never", "note": "reveal gallery", "settleMs": 2000 }
  ]
}
```
- `steps`: ordered. `click` targets by `text` (accessible name from
  inspect) or `selector` (CSS) — prefer `text`. `wait` paces the video.
- `settleMs`: how long to hold after a click so its animation/result is
  visible (≈1300–2000ms is good).
- `startCursor`: where the synthetic cursor begins (viewport px).

### 4. Render
```
node packages/cli/dist/cli.js make --plan plan.json --out demo.mp4
```
Produces `demo.mp4` and `demo.composition.json` (the editable source).

### 5. Show the user
Show `demo.mp4`. Tell them they can refine it by talking — adjust which
beats zoom, pacing, ordering — by editing the composition (refinement is
the next-tier capability).

## Editorial guidance (what makes a good draft)
- Lead with an orienting beat so the viewer sees the app whole.
- Pick the app's *signature* moment as the hero (e.g. a theme flip, a
  live interactive component, a striking page). If the hero is global,
  show it full-view, not zoomed.
- One strong closer (a gallery, a result, a completed action).
- Keep total length ~25s; snappy beats read better than long holds.
- Don't click things that navigate away from the app (e.g. external
  links) — they break the demo.

## Capture robustness (baked into the engine — rely on it)
- Target by accessible `name` (`text`) — robust on real apps.
- The CLI handles agent-browser's `--json` eval quirks, so a target's
  bbox is never silently dropped. If a click reports "target not found",
  re-run `inspect` (names/layout may have changed) and fix the `text`.
- A missing target is logged loudly, not silently skipped.

## Prerequisites
- `agent-browser` 0.27+ available on PATH.
- Build once: `pnpm install && pnpm build` (then the CLI lives at
  `packages/cli/dist/cli.js`).
- `ffmpeg`/`ffprobe` available (the engine ships prebuilt fallbacks; the
  repo's install fixes their executable bit).

## Known limits (don't be surprised)
- Background capture is ~10fps today (agent-browser screencast) — fine
  for click-paced demos; scroll/drag/video demos will look choppy until
  the capture-fps decision lands. The synthetic cursor/zoom are smooth.
- viewport ≠ video scaling is implemented but lightly tested.
