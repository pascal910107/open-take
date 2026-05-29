---
name: open-take
description: Make a polished ~25s demo video of a web app the user names ("make a demo of <url/app> for Twitter"). Explore the app, decide the IDEAL demo editorial-first, render a cinematic MP4 (smooth synthetic cursor + selective click-zoom) plus an editable composition. Use when the user wants a shareable product demo of a running web app.
---

# open-take — make a demo of an app

You drive a real web app and produce a polished, shareable demo. The engine
already does the cinematic polish (eased synthetic cursor, bbox-fit click-zoom,
framing). **Your job is editorial: decide what demo is worth making, then make
it.**

The honest promise: you produce a strong *draft*. The output includes an
editable composition; the user refines toward "brilliant" by talking. Don't aim
for one-shot perfection — aim for a coherent, legible draft that shows the
product's real wow.

## The one rule: EDITORIAL FIRST, CAPTURE SECOND

The failure mode this skill exists to prevent: **letting "what I can reliably
click" decide the story.** That produces a demo that opens the page and clicks a
few buttons — competent, forgettable, not something a founder would post.

So: **decide the ideal demo FIRST** (what would make someone stop scrolling),
*then* figure out how to capture it. Only downgrade a beat if capture genuinely
fails — and when you downgrade, **say so out loud** (it's a real product
limitation, not something to paper over).

## The loop

Run these five steps in order. Write down your answers for steps 1–3 *before*
you touch the capture tooling — that's what keeps you honest.

### 1. UNDERSTAND (explore before deciding anything)
Open the app and look. You may use the CLI's `inspect` (below) and/or drive
`agent-browser` directly (`open`, `screenshot`, `snapshot`, `eval`) to see what
the app *is* and what its interactions *do*. Answer, in writing:
- **What is this product and who is it for** — one sentence.
- **What is its SINGLE most impressive / differentiating thing** — the "wow"
  that makes someone stop scrolling. (Not "it has a nice UI." The specific
  moment.)
- **What ONE story should a ~25s demo tell** — one sentence.

### 2. DIRECT (the editorial work — ignore capture feasibility here)
Choose **3–5 beats** forming ONE coherent arc: a hook in the first ~2s → a
couple of meaningful interactions → a clear payoff/closer. For each beat write:
**what it shows · why it earns its place · what the viewer should feel.**

Decide the *ideal* version even if you're not sure you can capture it. Lead with
the app's signature moment; make the wow the hero, not an afterthought.

**Zoom — decide per beat by payoff locality:**
- Zoom **only** when the payoff is **local AND co-located with the click** — a
  popover, dropdown, inline result, or small control whose effect appears right
  where you clicked. That's where the cinematic zoom earns its place (`"always"`).
- **No zoom** (`"never"`) when the payoff is **global** (theme flip, whole-page
  restyle, navigation) OR **relocated** from the click (you click a button here,
  the result appears elsewhere — the engine zooms to the *clicked element's*
  bbox, so zooming would frame the wrong place).
- Restraint reads as intentional. Reserve zoom for 1–2 beats at most; many great
  demos are 0-zoom. Don't add a zoom for "variety."

### 3. SELF-CRITIQUE (before building — revise if it fails)
Ask, honestly:
- **Is this the demo, or just the easy clicks?**
- **Is the wow actually in here?**
- **Would a skeptical founder post this?**

If the answer to any is weak, revise the DIRECT step. This is also where you map
the ideal onto the capture vocabulary (next section) and decide your downgrades.

### 4. CAPTURE & RENDER (through the runtime)
Write the plan (schema below), then `make`. The runtime drives the live app and
composites the polish.

**The capture vocabulary is `click` + `wait` only** — no `type`, no `drag`, no
`scroll`, no `hover`. This is the binding constraint. When a beat from your
ideal needs something the vocabulary lacks:
1. **Find a click-only path to the SAME editorial point.** Most apps have one
   (an example/preset button instead of typing; a "load template"/built-in
   sample instead of drawing; a feature dialog that ships pre-filled). The point
   is the *wow*, not the mechanic.
2. **If there's genuinely no click-only path, downgrade and flag it explicitly**
   in your write-up. Do NOT silently fall back to clicking inert UI (selecting a
   drawing tool draws nothing; clicking nav for its own sake says nothing). An
   honest "the ideal needs drag/type, which the runtime can't capture yet" is a
   real finding — surface it.

### 5. SHOW (frames, not claims)
Extract frames from the MP4 and **look at them** before you call it done:
```
ffmpeg -i demo.mp4 -vf "fps=8/<dur>,scale=480:-1,tile=5x2" contact.png   # contact sheet
ffmpeg -ss <t> -i demo.mp4 -frames:v 1 frame.png                          # a single moment
```
Then show the user the MP4 + your UNDERSTAND/DIRECT/CRITIQUE notes, and give an
honest read on **editorial quality** (is the wow in there?), not just mechanics.
Tell them they can refine by talking (which beats zoom, pacing, ordering) — the
composition is editable.

## Mechanics

### inspect (planning aid)
```
node packages/cli/dist/cli.js inspect <url> [--viewport 1920x1080]
```
Returns `{ url, viewport, elements: [{name, tag, role, href, inView, x,y,w,h}] }`
— elements with an **accessible name**. Target these by `text` (the locator).

**`inspect` only sees accessibly-named `button/a/[role]/input` elements.** Many
real controls are unlabeled icon-buttons or `<div>`s with click handlers (app
toolbars, canvas tools) and won't appear. For those, drive `agent-browser`
directly to find a stable **CSS selector** (`eval` a `document.querySelectorAll`
dump of classes / `data-testid` / `getBoundingClientRect`), and target by
`selector`. Verify the interaction actually fires before planning it (e.g.
`eval` `el.click()` and check the page changed).

### plan.json (a TakePlan)
```json
{
  "url": "https://example.com/",
  "viewport": { "width": 1920, "height": 1080 },
  "startCursor": { "x": 480, "y": 300 },
  "steps": [
    { "action": "wait", "ms": 1100 },
    { "action": "click", "selector": ".some-icon-button", "zoom": "never", "note": "global payoff", "settleMs": 2000 },
    { "action": "click", "text": "Open menu", "zoom": "always", "note": "local co-located popover", "settleMs": 1600 }
  ]
}
```
- `click` targets by `text` (accessible name — robust) **or** `selector` (CSS —
  for unlabeled controls). Both resolve the bbox and click in one atomic page
  eval. Prefer `text`; use `selector` when there's no accessible name.
- `settleMs`: hold after a click so its result is visible (~1300–2600ms). Give
  big reveals a longer hold.
- `wait`: paces the video / orients at the start.
- `startCursor`: where the synthetic cursor begins (viewport px); pick a spot
  that makes the first move to your first target a pleasing sweep.

### make (render)
```
node packages/cli/dist/cli.js make --plan plan.json --out demo.mp4
```
Produces `demo.mp4` (1920×1080 @ 30fps) and `demo.composition.json` (editable).

## Capture robustness — checks that keep "user does nothing" honest
- **Confirm no beat was dropped.** A missing target logs `captureTake: target
  not found, skipped: …` to stderr, and the composition will have **fewer
  `events` than you have `click` steps**. Check that count. If a beat was
  dropped, fix the target (re-`inspect`; names/layout may have changed) or just
  re-run (capture can flake on a cold first run) — never ship a silently-empty
  demo. ALWAYS look at the frames (step 5) to catch this.
- **Reset persistent app state.** Stateful apps (canvas tools, editors) persist
  to `localStorage`, and the recorder shares the browser profile across runs —
  so you can open onto leftover content instead of a clean slate. Clear it
  first: `agent-browser --session-name x open <url>` then
  `eval 'localStorage.clear()'`, close, then `make`.
- **Target unlabeled controls by CSS selector**, resolved via `agent-browser
  eval` (see inspect note). The selector path is atomic (resolve-bbox-and-click
  in one eval), so it's as robust as the text path.

## Editorial guidance (what makes a good draft)
- Lead with an orienting beat so the viewer sees the app whole; the
  first/orienting beat usually should not zoom.
- Make the app's *signature* moment the hero. If the hero is global (a restyle,
  a navigation), show it full-view — don't zoom into it.
- One strong closer (a result, a completed action, a striking page/state).
- **~25s is a target, not a floor.** A tight, all-signal 12–18s draft beats a
  padded 25s. Snappy beats read better than long holds.
- Don't click things that navigate away from the app (external links) — they
  break the demo.

## Known limits (don't be surprised; flag when they bite the story)
- **Vocabulary = click + wait.** No type/drag/scroll/hover. This is the main
  ceiling on editorial quality: apps whose wow is *sketching, typing, dragging,
  or scrolling through content* can only be shown via click-only proxies — say
  so when you downgrade.
- **Background capture is ~10fps** (agent-browser screencast) — great for
  discrete click→state-change demos; scroll/drag/continuous-animation will look
  choppy. The synthetic cursor and zoom are rendered smooth at 30fps regardless.
- viewport ≠ video scaling is implemented but lightly tested.

## Prerequisites
- `agent-browser` 0.27+ on PATH.
- Build once: `pnpm install && pnpm build` (CLI at `packages/cli/dist/cli.js`).
- `ffmpeg`/`ffprobe` available (used for render + for extracting frames).
