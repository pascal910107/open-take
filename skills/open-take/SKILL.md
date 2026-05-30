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
Open the app and look. Use the CLI's `inspect` (below) to list interactive
elements (name + bbox), and open the URL in any browser to see what the app
*is* and what its interactions *do*. Answer, in writing:
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
- For a **`drag`**, the engine fits the zoom to the **whole stroke's bounding
  box** (a path, not a point). A big cross-canvas stroke fills the frame already
  → `"auto"` keeps it full-view (correct). A small, localized drag → `"auto"`
  zooms in. Use `"never"` to force full-view for a sweeping gesture.
- **Progressive zoom (zoom in, then zoom in MORE).** Consecutive zoom beats
  don't reset to full view between them — the engine **pans and re-scales from
  one zoom target straight to the next** (the cinematic, premium style). So you can open
  a region, then push deeper: e.g. `click`(zoom a panel) → `hover`(zoom a control
  *inside* it). A later beat on a *smaller* element gets a *higher* scale, so it
  reads as "going deeper." Use this for reveal→detail arcs; it only zooms back
  out at the end (or for a `scroll`/full-view beat). Still selective — 2–3
  chained zooms max, each earning it.
- Restraint reads as intentional. Reserve zoom for the beats that earn it; many
  great demos are 0-zoom. Don't add a zoom for "variety."

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

**The capture vocabulary is `click` · `type` · `drag` · `scroll` · `hover` ·
`press` · `wait`.** It covers most product wows directly:
- **click** — trigger UI / orient / navigate.
- **type** — search boxes, AI prompts, forms (real keystrokes).
- **drag** — sketch / draw / move on a canvas (a *path*, not a point).
- **scroll** — pan a landing page or feed to reveal content (to an element by
  name, or a fixed amount); the frame stays full-view as the content moves.
- **hover** — dwell on an element to reveal a tooltip / dropdown / hover-state.
- **press** — a key or shortcut (Enter to submit, Escape, ⌘K palette, arrows).

**Use the real mechanic.** If the wow is drawing, *drag to draw it*; if it's
search, *type the query then `press` Enter*; if it's a hover-reveal, *hover*; if
it's "scroll through the gorgeous landing page", *scroll*. Reach for a proxy
(and flag the downgrade out loud) only when the genuine action genuinely isn't
expressible — e.g. a hover-reveal whose menu has no accessible name AND no
stable selector. Don't silently fall back to clicking inert UI.

### 5. SHOW (frames, not claims)
Extract frames from the MP4 and **look at them** before you call it done:
```
ffmpeg -i demo.mp4 -vf "fps=8/<dur>,scale=480:-1,tile=5x2" contact.png   # contact sheet
ffmpeg -ss <t> -i demo.mp4 -frames:v 1 frame.png                          # a single moment
```
Then show the user the MP4 + your UNDERSTAND/DIRECT/CRITIQUE notes, and give an
honest read on **editorial quality** (is the wow in there?), not just mechanics.
Tell them they can refine by talking — the composition is editable.

### 6. REFINE (talk-to-edit — the honest promise)
The draft is *competent*; **brilliant comes from the user talking.** When they
react ("zoom less on the search", "hold the result longer", "tighter on the
logo", "slower intro"), you **edit `demo.composition.json` and `render`** — you do
**not** re-`make`. This is the product's core loop, so treat it as first-class.

**Why it's cheap and safe:** `make` keeps the raw recording as
`demo.capture.mp4`. `render` re-composites the *cinematic layer* (zoom, cursor,
framing, pacing) over that frozen capture — **no app drive**. So a refine is
~3× faster than a `make` (it skips the real-time capture) and **deterministic**:
only your edit changes; the app can't drift, flake, or re-animate differently.

**The boundary (be honest about it):**
- **Editable by `render` (cinematic layer):** which beats zoom + how tight
  (`zoom.enabled`/`scale`/`center`), zoom/hold pacing (`inAtMs`, `cursor.zoomInMs`/
  `zoomOutMs`/`holdMs`), framing (`framing.insetFrac`/`background`/`cornerRadius`),
  cursor feel/speed (`cursor.travel*`, `arc*`, easings), the intro travel
  (`start`), and the tail (`durationMs`).
- **Needs a fresh `make` (choreography):** what's clicked/typed/dragged, the beat
  **order**, drag paths, typed text — and **an action beat's `tMs`**. The video is
  temporal: `tMs` is *when that action is visible in the recording*, so moving it
  desyncs the overlay from the on-screen action. You cannot retime an action by
  editing JSON; re-capture to retime. **The capture-lock enforces this in the loop:**
  `make` writes `<out>.capture.json` (the ground-truth log) and `render` auto-loads
  it, so a drifted action `tMs` is *refused* with a field-precise error before any
  render.

Edit → `render` → SHOW → repeat until the user is happy. See **refine** under
Mechanics for the language→field map.

## Mechanics

### inspect (planning aid)
```
node packages/cli/dist/cli.js inspect <url> [--viewport 1920x1080]
```
Returns `{ url, viewport, elements: [{name, tag, role, href, inView, x,y,w,h}] }`
— elements with an **accessible name**. Target these by `text` (the locator).

**`inspect` only sees accessibly-named `button/a/[role]/input` elements.** Many
real controls are unlabeled icon-buttons or `<div>`s with click handlers (app
toolbars, canvas tools) and won't appear. For those, open the URL in any browser
DevTools to find a stable **CSS selector** (classes / `data-testid` /
`getBoundingClientRect`), and target by `selector`. Verify the interaction
actually fires before planning it (in the console: `el.click()` and check the
page changed).

### plan.json (a TakePlan)
```json
{
  "url": "https://example.com/",
  "viewport": { "width": 1920, "height": 1080 },
  "startCursor": { "x": 480, "y": 300 },
  "steps": [
    { "action": "wait", "ms": 1100 },
    { "action": "click", "selector": ".some-icon-button", "zoom": "never", "note": "global payoff", "settleMs": 2000 },
    { "action": "type", "text": "Search the docs", "value": "polished demos, on tap", "zoom": "always", "note": "search box", "settleMs": 1200 },
    { "action": "press", "keys": "Enter", "selector": "#result", "zoom": "always", "note": "Enter submits → frame the result", "durationMs": 1200, "settleMs": 800 },
    { "action": "press", "keys": "Meta+k", "selector": ".palette", "zoom": "always", "note": "⌘K opens the palette", "durationMs": 1400, "settleMs": 600 },
    { "action": "scroll", "toText": "Pricing", "note": "pan down to the pricing section", "durationMs": 1100, "settleMs": 900 },
    { "action": "hover", "text": "Profile", "zoom": "always", "note": "tooltip reveal", "durationMs": 1400, "settleMs": 600 },
    { "action": "click", "text": "Open menu", "zoom": "always", "note": "local co-located popover", "settleMs": 1600 },
    { "action": "drag", "from": { "x": 560, "y": 400 }, "to": { "x": 1140, "y": 400 },
      "path": [{ "x": 560, "y": 400 }, { "x": 760, "y": 250 }, { "x": 1140, "y": 400 }],
      "durationMs": 1370, "zoom": "auto", "note": "sketch on the canvas (~660px path ÷ 480px/s)", "settleMs": 1200 }
  ]
}
```
- **`click`** targets by `text` (accessible name — robust) **or** `selector`
  (CSS — for unlabeled controls). Both resolve the bbox and click in one atomic
  page eval. Prefer `text`; use `selector` when there's no accessible name.
- **`type`** locates a field by `text` (its accessible name **or placeholder**)
  or `selector`, focuses it, and types `value` with real keystrokes, char by
  char (the cursor parks on the field and the zoom holds while text appears).
  For search boxes, AI prompts, forms. The field is usually a small target →
  `"always"`/`"auto"` frames it nicely.
- **`drag`** is a path with the button held — the canvas wow (sketch, draw a
  shape, move an element). Give a **start** and **end**, each as either an
  explicit viewport point (`from` / `to`) or a located element (`selector`/`text`
  for the start, `toSelector`/`toText` for the end → bbox centre). Add an
  optional `path` of viewport points for a freehand curve (overrides the straight
  start→end line). The stroke **accelerates in, decelerates out** (`dragEasing`
  default `"smooth"` — a natural hand-draw; the cursor replays the same easing so
  it rides the ink front). Set `dragEasing: "linear"` (a capture option) for a
  constant-speed stroke. **Pace `durationMs` by the path's LENGTH, not a fixed
  number** — aim for a calm, confident **~480 px/s** (`durationMs ≈ pathLength /
  0.48`). A 500px stroke → ~1040ms; an 800px wave → ~1670ms. Below ~400 px/s reads
  sluggish, above ~600 hurried; 2000ms+ is almost never right (the old "slow draws
  read better" was a low-fps workaround). On `--fps 30` you can lean a touch slower.
  - *Canvas surfaces have no element to target:* get the canvas bbox first
    (`inspect`, or a one-off CDP `getBoundingClientRect`), then compute `from`/`to`/
    `path` points **inside** it. Select the drawing tool with a `click` *before*
    the drag.
- **`scroll`** pans the page. Either `toSelector`/`toText` (scroll until that
  element is centred — robust, prefer this) or `dy` (signed pixels, + = down;
  default ~0.8 viewport). The cursor **holds** (content moves underneath) and the
  frame stays **full-view** — a scroll never zooms (and any prior zoom releases
  to full-view for it). `durationMs` ≈ 900–1400. Use it to reveal sections of a
  landing page / scroll a feed.
- **`hover`** moves the cursor onto an element (by `text`/`selector`) and
  **dwells** (`durationMs` ≈ 1200–1600) so a tooltip / dropdown / hover-state
  shows — no click. Zooms like a click (auto/always); use `"never"` when the
  reveal (a wide menu) spills past the element's own bbox.
- **`press`** sends a key or shortcut via `keys`: a named key (`"Enter"`,
  `"Escape"`, `"Tab"`, `"ArrowDown"`) or a combo (`"Meta+k"`, `"Control+Shift+p"`,
  `"Shift+Tab"`). Keyboard-driven, so the **cursor does not move**. The press
  lands on whatever has focus (e.g. a field a prior `type` filled → `Enter`
  submits) or the document (⌘K-style listeners). To zoom on what it reveals, name
  that element via `selector`/`text` (it's located *after* the press, then
  framed). A bare press (no reveal) holds **full-view** for `durationMs`.
- `settleMs`: hold after the action so its result is visible (~1200–2600ms).
  Give big reveals a longer hold. **Pacing matters for cursor silk:** the cursor
  travels to the next target during the gap BEFORE it, so a tight gap forces a
  fast, snappy move. When you pick a tool then immediately draw (`click` a
  toolbar → `drag` on the canvas), give the click a generous `settleMs`
  (**~1000–1200ms**) so the cursor can glide to the canvas at a calm, constant
  speed instead of darting. Cramped gaps (<800ms) make the travel feel rushed.
- `wait`: paces the video / orients at the start.
- `startCursor`: where the synthetic cursor begins (viewport px); pick a spot
  that makes the first move to your first target a pleasing sweep.

### make (render)
```
node packages/cli/dist/cli.js make --plan plan.json --out demo.mp4            # 60fps (default)
node packages/cli/dist/cli.js make --plan plan.json --out demo.mp4 --fps 30   # fast-draft
```
Produces `demo.mp4` (1920×1080 @ **60fps default**) and
`demo.composition.json` (editable).

**fps (default 60).** Capture is always a pure-CDP screencast (drives AND
records over a self-launched headless Chrome); `--fps` sets both the capture
encode and the render grid. 60 is the premium, cinematic feel — continuous
motion (`drag`/sketch, scroll, video) stays smooth and the ink keeps up with the
cursor. **`--fps 30` halves render time + file size** — use it for fast drafts
while iterating, or for pure click/type demos where the gain is marginal. Needs
a Chrome — auto-downloads Chrome-for-Testing on first run, or set
`OPEN_TAKE_CHROME`.

`make` prints all four artifacts and the exact `render` command to refine:
```
mp4:         demo.mp4
composition: demo.composition.json   ← edit this
capture:     demo.capture.mp4        ← render reads this (the frozen recording)
capture log: demo.capture.json       ← render auto-loads this (capture-lock ground truth)
```

### refine (re-render edits — no app drive)
```
node packages/cli/dist/cli.js render \
  --composition demo.composition.json --video demo.capture.mp4 --out demo.mp4
```
Re-renders the **edited** composition over the **kept** capture. Auto-loads the
sibling capture log (`demo.capture.json`) as the capture-lock ground truth
(`--capture-log <path>` overrides it). Validates first and **refuses to render an
errored composition** (prints the field + a suggested fix in milliseconds, before
paying for a render) — e.g. a `zoom.scale` below the rest scale (zooms *out* past
the frame), a `zoom.inAtMs` after its action, or a **drifted action `tMs`** (the
capture-lock). Warnings (a no-op zoom, a soft-cap scale) print but don't block.

**Map the user's words to fields** (edit `demo.composition.json`, then `render`):
- *"don't zoom on X" / "too zoomy"* → that beat's `zoom.enabled: false`.
- *"zoom on X" / "tighter on X"* → `zoom.enabled: true` and/or raise `zoom.scale`
  (toward ~2.0; the validator soft-caps ~2.5). If the beat has a `bbox`, set
  `center` to its middle (`{x: bbox.x+bbox.w/2, y: bbox.y+bbox.h/2}`); a bbox-less
  beat (a bare `press`) needs a hand-set `center` in video-px.
- *"hold X longer" / "too quick"* → raise `cursor.holdMs` (global) — the dwell
  after a beat settles before zooming out.
- *"gentler / faster zoom"* → `cursor.zoomInMs` / `zoomOutMs` (bigger = slower
  ramp); soften the curve with `cursor.zoomEase`.
- *"start the zoom earlier"* → lower that beat's `zoom.inAtMs` (keep it ≥ 0 and
  ≤ `tMs`; the default is `tMs − cursor.zoomInMs`).
- *"tighter frame / less border"* → raise `framing.insetFrac` (toward 1.0);
  *"more cinematic backdrop"* → `framing.background.from/to`, `cornerRadius`.
- *"slower / silkier cursor"* → lower `cursor.travelWidthsPerSec` (or raise
  `travelMaxMs`); *"less curve"* → lower `cursor.arcFrac`/`arcMax`.
- *"slower intro"* → move `start` farther from the first target (longer opening
  sweep), or add a leading `wait` **and re-`make`** if you need real dead time
  before the first action (dead time is capture, not composition).
- *"trim the end" / "it lingers"* → lower `durationMs` (keep it past the last
  action + `cursor.zoomOutMs`, or the final zoom-out gets cut).
- *"reorder / cut / change what it does / retime a beat"* → **choreography:
  re-`make`** with an edited plan. `render` can't move an action in time (its
  `tMs` is locked to the recording).

## Capture robustness — checks that keep "user does nothing" honest
- **Confirm no beat was dropped.** A missing target logs `captureTakeCDP: … not
  found, skipped: …` to stderr, and the composition will have **fewer `events`
  than you have action steps** (click/type/drag/scroll/hover/press are events;
  `wait` is not). Check
  that count. If a beat was dropped, fix the target (re-`inspect`; names/layout
  may have changed) or just re-run (capture can flake on a cold first run) —
  never ship a silently-empty demo. ALWAYS look at the frames (step 5) to catch
  this.
- **For `drag`, verify the stroke actually rendered.** A drag whose endpoints
  resolved still produces *nothing visible* if the wrong tool was active or the
  surface ignored synthetic input — eyeball the frames mid-stroke. (Select the
  tool with a `click` first; CDP mouse input is trusted, so canvas libs that
  listen for pointer events do respond.)
- **App state starts clean each run.** Capture launches Chrome on a fresh temp
  profile (removed on close), so `localStorage`/cookies do NOT leak between runs
  — a stateful app (canvas tool, editor) opens empty every time. If your demo
  *needs* seeded state, set it up within the plan itself (type/click your way
  in), not across runs.
- **Target unlabeled controls by CSS `selector`** (see inspect note). The
  selector path is atomic (resolve-bbox-and-click in one page eval), so it's as
  robust as the text path.

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
- **Vocabulary = click · type · drag · scroll · hover · press · wait.** Covers
  most product wows directly. Remaining edges to flag when they bite: a
  hover-reveal whose menu has no accessible name *and* no stable selector;
  multi-key sequences within one beat (chain separate `press` steps); precise
  inner-scroller targeting (scroll dispatches a wheel at viewport centre, so it
  pans the main document — a nested scroll region that isn't under centre may
  need a `dy` tuned by hand). A real text-drag selection isn't a first-class verb
  (use `drag` across the text, but it won't always select).
- **fps: default 60 (capture + render), pure-CDP screencast.** Continuous
  motion (`drag`, scroll, animation) is smooth and the ink stays locked to the
  synthetic cursor. `--fps 30` halves render time + file size — fine for fast
  drafts and pure click/type demos; on a 30fps render, soften strokes with a
  slower `durationMs` (1500–2500ms). The old ~10fps agent-browser ceiling is
  gone entirely.
- viewport ≠ video scaling is implemented but lightly tested.

## Prerequisites
- A Chrome to drive: open-take auto-downloads **Chrome-for-Testing** on first
  run (cached under `~/.open-take/browsers`), or set `OPEN_TAKE_CHROME` to a
  Chrome binary. (No agent-browser needed — capture is pure CDP.)
- Build once: `pnpm install && pnpm build` (CLI at `packages/cli/dist/cli.js`).
- `ffmpeg`/`ffprobe` available (used for render + for extracting frames).
