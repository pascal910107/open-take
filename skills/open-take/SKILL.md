---
name: open-take
description: Make a polished ~25s demo video of a web app the user names ("make a demo of this app for Twitter"). Explore the app, decide the IDEAL demo editorial-first, render a cinematic MP4 (smooth synthetic cursor + selective click-zoom) plus an editable composition. Use when the user wants a shareable product demo of a running web app.
---

# open-take — make a demo of an app

You drive a real web app and produce a polished, shareable demo. The engine
already does the cinematic polish (eased synthetic cursor, bbox-fit click-zoom,
framing). **Your job is editorial: decide what demo is worth making, then make
it.**

The honest promise: you produce a strong *draft*. The output includes an
editable composition; the user refines toward "brilliant" by giving you notes in
plain language. Don't aim
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

Run this loop in order. Write down your answers for UNDERSTAND through
SELF-CRITIQUE *before* you touch the capture tooling.

### 1. UNDERSTAND (explore before deciding anything)
Open the app and look. Use the CLI's `inspect` (below) to list interactive
elements (name + bbox), and open the URL in any browser to see what the app
*is* and what its interactions *do*.

**Explore efficiently — the measured time sink is HERE, not the renders:**
- **Read the dossier FIRST.** A previous demo of this app left
  `<base>.take/dossier.md` in its working dir — the last run's exploration harvest
  (what the app is + audience, hero candidates tried AND rejected, the
  verified selector map, content answers, hazards). If one exists, read it
  before touching the app, and re-verify only what could be stale: one
  `inspect` diffed against its selector map + a spot-probe of the hero
  interaction. Founders iterate on ONE app — every demo after the first
  should skip cold exploration, not re-pay it.
- **Confirm the target first.** `inspect` returns the page `title` + `finalUrl`
  — check they name the app you were asked to demo before exploring anything
  (dev servers auto-increment ports; a stale URL silently serves a different
  project).
- **Front-load a source read.** If the app's source is available, start a
  parallel source read (a subagent, if your host has one) the moment you have
  the URL, and probe the live app while it runs. Selectors, routes, seeded
  data, and feature lists come back cheaper from source than from clicking.
- **Answer content questions from source, never by UI trial-and-error.** "Which
  search term has hits on a distant page", "what data exists to demo with",
  "what does this list contain" — grep the source/data files ONCE instead of
  probing the UI one query at a time (a measured run burned ~4 min on 9
  serial search-term probes that one grep would have answered).
- **Batch UI probes.** Take screenshots / run interaction probes in batches,
  not one round-trip each; lazy-loading apps make serial probing expensive.
  A screenshot taken DURING a smooth scroll/animation can capture a blank
  compositing frame that contradicts the DOM — re-shoot once settled before
  concluding anything is broken.
- Interaction probing is still irreplaceable for *behavior* (focus races,
  animation timing, what a click actually reveals) — spend the round-trips
  there, not on content questions.

Answer, in writing:
- **What is this product and who is it for** — one sentence.
- **What is its SINGLE most impressive / differentiating thing** — the "wow"
  that makes someone stop scrolling. (Not "it has a nice UI." The specific
  moment.)
- **What ONE story should a ~25s demo tell** — one sentence.

**Alignment gate — ask EARLY, confirm before DIRECT.** Use the host's
structured question tool (Claude Code: `AskUserQuestion`; other agents: the
equivalent) to ask which story the demo should prove — and ask it **the moment
you have 2–3 credible hero candidates**, not when exploration feels finished.
The human's answer takes minutes to arrive; exploration and the question must
overlap, never serialize (explore → ask → idle wait is the measured
anti-pattern). While the answer is pending, keep working on the parts that
don't depend on it: verify selectors, answer content questions from source,
map hazards. Skip the question only when the user already gave an unambiguous
audience/purpose **and** hero outcome, or explicitly said to use your
judgment; when skipping, restate the brief so they can correct it.

- Ask **one question by default, two maximum**. Do not make the user restate
  facts you can observe in the app.
- Offer **2–3 concrete hero + payoff stories** grounded in what you observed,
  put the recommended option first, and explain its advantage in one sentence.
  If only one story is credible, ask the user to confirm that thesis and allow
  a correction instead of inventing weak alternatives.
- Ask audience/purpose as the second question only when it is unknown and
  would materially change the story.
- Do not write the plan or run `make` until a required answer arrives.

**Unattended runs (CI, cron — no human on the channel).** When the invocation
says no human is available (`open-take ci` writes exactly such a brief), the
alignment gate is PRE-ANSWERED: treat the given brief as the confirmed story —
or, when it says "use your judgment", pick the strongest thesis yourself and
name it in your final summary. Never call AskUserQuestion or block waiting for
input. The dailies loop is bounded there too: verify with `frames`, fix what
composition warnings name, at most two re-makes, ONE master render at the end —
and none of the human-loop verbs (`edit`, `notes --wait`, `ab`, `auth`). The
dossier is not optional in CI: the runner caches the take dir between runs, and
the dossier is what turns the next run's cold exploration into a cheap
re-verify.

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
  bbox, so zooming would frame the wrong place). A `never` beat RELEASES any
  prior zoom — the camera pulls back to full view for it, so a global payoff
  after a zoomed beat is shown whole.
- **HOLD THE FRAME when a beat CONFIRMS the one before it.** Type a project
  name → click Deploy. Type a query → click Search. Fill a field → click Save.
  The click's payoff is global, so `"never"` looks right — but `never` releases
  the camera *at the instant of the click*, and the frame slides out from under
  the very action the viewer came to see. It reads as panicky, and it is the
  most common camera mistake in a form demo. Instead, give the confirming beat
  the SAME framing as the setup beat: copy `events[n-1].zoom`'s `center` and
  `scale` onto it in the composition (leave `inAtMs` at the planner default).
  Identical framings mean **no camera move at all** — the shot is dead still
  through the click, which is exactly what the product launch videos this
  imitates do. Release to full view on the NEXT beat, once the global payoff
  has actually appeared on screen. The validator flags the unheld case:
  *"the camera has only N% of its move done when this beat's action fires"*.
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
- **Fits ≠ legible.** The auto-camera frames the payoff region so it FITS the
  frame; it has no notion of type size. When the payoff's *meaning* lives in
  small text (code, terminal output, an inspector panel, dense tables), a fit
  that technically shows the whole region can still be unreadable at a glance
  — a measured run's hero beat read as a pointless pull-back until its zoom
  was hand-set to 1.75×. For fine-text payoffs, hand-set that beat's
  `zoom.scale` toward medium/tight (1.5–1.8) so the text itself reads.
- **Frame the CONTAINER, not the control.** The auto-camera fits the changed
  region — for a `type` beat that's the input and the text appearing in it. A
  field sitting in the right half of a dialog therefore yields a frame centred
  on the field, with the card's other edge *cropped off* and empty page on the
  opposite side. Whenever the beat's meaning includes its surroundings (the
  form's label, its primary button, the dialog it lives in), hand-set that
  beat's `zoom.center`/`scale` to the CONTAINER's box instead:
  `center = {x: box.x+box.w/2, y: box.y+box.h/2}`, `scale =
  min(1920/(box.w·1.15), 1080/(box.h·1.15))`. Read the container's box off a
  full-res capture frame (`ffmpeg -ss <t> -i <base>.take/capture.mp4 -frames:v 1
  -vf scale=<viewportW>:<viewportH> f.png`) — that frame is in viewport px, the
  same space `zoom.center` uses.
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
Write the plan (schema below), then `make --draft`. The runtime drives the live
app and composites the polish.

**Post the thesis + beat plan to the user BEFORE running `make`** — one line
of thesis, then the 3–5 beats with what each shows. The shoot + render takes
minutes; the user spends them reading your editorial instead of watching a
spinner. `make` auto-opens the raw capture the moment it lands (minutes before
the polished mp4): tell the user that's the **unpolished footage** — real
pixels, no camera work yet — and that the polish is still rendering
(`--no-open` suppresses it). **Draft-first is the default loop:** the first
render and every mid-refine re-render are drafts (30fps cap, no motion blur —
several times faster); the full-quality master is rendered ONCE, at the closing
ritual. The capture itself still records at the full fps and the composition
keeps the full-quality settings, so nothing is lost — only deferred.

**The capture vocabulary is `click` · `type` · `drag` · `scroll` · `hover` ·
`press` · `navigate` · `wait`.** It covers most product wows directly:
- **click** — trigger UI / orient / navigate.
- **type** — search boxes, AI prompts, forms (real keystrokes).
- **drag** — sketch / draw / move on a canvas (a *path*, not a point).
- **scroll** — pan a landing page or feed to reveal content (to an element by
  name, or a fixed amount); the frame stays full-view as the content moves.
- **hover** — dwell on an element to reveal a tooltip / dropdown / hover-state.
- **press** — a key or shortcut (Enter to submit, Escape, ⌘K palette, arrows).
- **navigate** — go to another page mid-take, in the same tab, without breaking
  the recording. Emits no beat (a navigation is global — show it full-view), and
  the new document gets the same font wait the take's first page gets.

**`navigate` destinations are LATE-BOUND — that is the point.** A plan is
written *before* the capture runs, so the second page's URL is often something
only the run itself produces. Say where to read it from:
```jsonc
{ "action": "navigate", "url": "/pricing" }                         // relative to the current page
{ "action": "navigate", "hrefFrom": { "text": "Visit" } }           // whatever the app just linked to
{ "action": "navigate", "hrefFrom": { "text": "Visit" },
  "query": { "speed": "3" } }                                       // ...plus params no click could add
{ "action": "navigate", "query": { "demo": "1" } }                  // this same page, parameterised
```
Precedence is `hrefFrom` > `url` > the current page. `hrefFrom` is also the
answer to a `target="_blank"` link: the screencast is bound to one page target
and cannot follow a new tab, but it CAN go to that same href in the tab it is
already recording. A `hrefFrom` that matches nothing is a *skipped step* (it
shows up in the summary, and `--strict` fails the run) — never a silent jump.

**Use the real mechanic.** If the wow is drawing, *drag to draw it*; if it's
search, *type the query then `press` Enter*; if it's a hover-reveal, *hover*; if
it's "scroll through the gorgeous landing page", *scroll*. Reach for a proxy
(and flag the downgrade out loud) only when the genuine action genuinely isn't
expressible — e.g. a hover-reveal whose menu has no accessible name AND no
stable selector. Don't silently fall back to clicking inert UI.

### 5. SHOW (frames, not claims)
First verify it YOURSELF — get the beat-aware contact sheet and **look at it**:
```
npx open-take frames demo.mp4              # demo.take/frames.png + a row/time table
npx open-take frames demo.mp4 --beat 3     # 10-cell strip of one beat
```
`frames` samples off the REAL camera schedule: an intro row (dead-opening
check), one row per beat (a mid-travel cell + 4 samples across the camera's
HOLD), a tail row (lingering-ending check). **Judge framing and payoffs on
HOLD cells only** — cells labeled `(travel)`/`(tail)` are mid-motion by design;
misreading a settle tail as "the zoom didn't apply" is the classic false alarm
this exists to prevent. What to look for: every beat's payoff visible and
legible, no dead opening, no skipped beat, drags actually inked. A raw
`ffmpeg -ss <t> -i demo.mp4 -frames:v 1 frame.png` is still fine for one
specific moment.
Then hand the user the **review copy** — a fast draft with the beat numbers
burned into the frame (the video itself teaches how to refer to moments) and a
REVIEW watermark so it can't be mistaken for the postable master:
```
npx open-take render demo.mp4 --review        # auto-opens the player
npx open-take beats  demo.mp4                 # prints the beat sheet
```
Paste the beat sheet into the conversation with your UNDERSTAND/DIRECT/CRITIQUE
notes and an honest read on **editorial quality** (is the wow in there?). End
with one hint line — the whole vocabulary a first-timer needs:
> say it like: "beat 3: no zoom" · "tighter on beat 2" · "look: slate"

### 6. REFINE (the dailies loop — the user reacts, you cut)
The user is the director watching dailies; you are the editor. They give notes
in plain language ("the opening is too slow", "no zoom on beat 3", "darker
background"); you resolve, cut, and show. **Notes arrive in whatever language
the user is speaking — answer in that language, but keep every file you write
(plans, notes files, composition fields) in English.**

**The visual editor is the user's other door.** `npx open-take edit demo.mp4`
opens a local editor (preview + icon-rail settings + timeline with zoom
blocks); the user can drag zoom regions, switch looks, and tune motion there —
edits autosave into the SAME `demo.take/composition.json` you edit. Offer it when
the user wants to fine-tune many things by hand. Its Agent panel appends notes
to `demo.take/notes.md` and prints `NOTE {...}` lines on the `edit` process stdout.
Always re-read `demo.take/composition.json` before editing it yourself — the user
may have changed it in the editor. Its **Export** renders over the master
`demo.mp4` in place and keeps the version it replaced as `demo.take/prev.mp4`,
exactly like `render` — so `ab --before-after` still means "the take they just
reacted to" after a GUI export.

**Get woken when they leave you a note.** The editor is in the browser; you are
in a terminal. Start ONE waiter in the background right after you open it:

```
npx open-take edit  demo.mp4          # background: the editor server (stays up)
npx open-take notes demo.mp4 --wait   # background: EXITS on the first note
```

The waiter prints the new notes and exits — that exit is your wake-up. Handle
the batch (ECHO → resolve → render), then start a fresh waiter for the next
one; each waiter delivers one batch. Notes left while no waiter was running are
not lost: `npx open-take notes demo.mp4` drains whatever you have not read yet
(the read position lives in `demo.take/notes.cursor`; `--all` re-reads everything).
Run that drain whenever the user says they left notes, or before you render.

**Hard rules, in order:**

1. **ECHO before you touch anything.** Resolve every note to its target and say
   it in one line each — `→ beat 3 · 0:07 · key .panel · zoom tight → off` —
   so a misread costs a sentence, not a render. Resolve referents against the
   ground truth: beat numbers → `events[n-1]`; "at 0:07" → the beat whose window
   covers it; element words → fuzzy-match `events[].label`, then bboxes in
   `demo.take/capture.json`; "the opening"/intro → `start` + first beat; "the
   ending"/tail → `durationMs`.
2. **Triage each note by cost, and say the cost:**
   - **Instant (~10s draft):** anything in the cinematic layer — zoom on/off/
     tightness/center, pacing, look, finish, intro, tail. Edit
     `demo.take/composition.json` (presets below), then ONE `render --review` for ALL
     batched notes from the message. The badges re-burn so the sheet never goes
     stale. To verify an edit YOURSELF before showing it, `render --draft`
     (clean `<base>.take/draft.mp4`, no badges) then `frames demo.take/draft.mp4` —
     seconds, and the master is never touched mid-refine.
   - **A taste question ("how tight? tighter? faster?"):** never guess twice —
     run an `ab` reel with the bracketing values and ask for a letter:
     ```
     npx open-take ab demo.mp4 --set zoom=medium,close --beat 2
     ```
     The current state is always variant **A**, so **"A" means keep it** —
     that's the undo. ONE knob per reel (the tool enforces it). FEEL knobs
     (zoom tightness as motion, pace, finish/blur) render at full quality —
     motion blur must be judged by eye, never on a draft.
   - **Choreography (re-shoot, ~1min):** what's clicked/typed, beat order, drag
     paths, action timing. Say "that's a re-shoot (~1 min)" and get a yes, then
     re-`make`. **Beat numbers are re-dealt — re-run `render --review` + `beats`
     and re-post the sheet.**
3. **Every re-render (yours or the editor's Export) keeps the previous master as
   `demo.take/prev.mp4`** — "keep the old one" is mechanical:
   `npx open-take ab demo.mp4 --before-after` replays
   BEFORE then AFTER (twice) straight from the two files, no render.
4. **Failures become handoff, not dead ends.** A validator refusal prints the
   field + fix — relay it and apply the fix; never bypass validation. **A
   validator *warning* is not a refusal, and it is not noise.** Every render
   ends with `⚠ n composition warnings` in the summary when there are any —
   read them. A zoom that "punches into empty space", a press zoom that departs
   before the keypress, a tail that delivers a frozen screen: each one is a
   defect a viewer will see, and each has shipped before because the warning
   was printed at the START of a multi-minute render and got scrolled past.
   Fix it or say out loud why you're keeping it. Never post over one silently.
5. **The closing ritual.** On "done" / "ship it" (in any language): one
   full-quality master render,
   reveal it, and print the ready line — nothing else. In the draft-first loop
   this is the ONE place the 60fps + motion-blur master gets paid for:
   ```
   npx open-take render demo.mp4 --reveal
   ready: /abs/path/demo.mp4 · 17.3s · 1920×1080@60 · 8.4 MB
   ```

**The cheap/expensive boundary (why triage works):** `render` re-composites the
cinematic layer over the frozen `demo.take/capture.mp4` — deterministic, no app
drive. The video is temporal, so *what happens and when* (`tMs`, order, text,
paths) is capture-locked: `render` refuses a drifted `tMs`; those notes are
re-`make` jobs.

**Preset vocabulary (speak names, write numbers).** Curated bundles — see
`packages/compositor/src/presets.ts`; `beats` reverse-maps values to names, and
a non-matching value displays as `(custom)` — never silently round a custom
value (bbox-derived precision is ground truth):
- **zoom** (absolute scale): light 1.25 · medium 1.5 · tight 1.8 · close 2.2
- **look** (background+corners+shadow as ONE bundle): midnight (default) · ink ·
  slate · ocean · plum · ember · paper (light) · plain
- **pace** (cursor speed+hold+ramps+pull-out dwell as ONE bundle): calm ·
  natural (default) · brisk
- **finish** (motion blur): smooth (default, 6×0.7) · crisp (off, ~6× faster
  exports) · heavy (8×0.85)

## Mechanics

### inspect (planning aid)
```
npx open-take inspect <url> [--viewport 1920x1080]
```
Returns `{ url, finalUrl, title, viewport, elements: [{name, tag, role, href,
inView, x,y,w,h}] }` — elements with an **accessible name**. Target these by
`text` (the locator). **Check `title`/`finalUrl` first** — one glance catches
a stale port serving a different project before any exploration is wasted.

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
  `"always"`/`"auto"` frames it nicely. **`"clear": true`** selects the field's
  existing value first so the typing REPLACES it (rename / edit-a-setting /
  correct-text beats — without it, typing appends at the caret; a `press
  "Meta+a"` does NOT work, dispatched key events never run Chrome's editing
  commands). **`"perCharMs"`** overrides the typing pace (default auto-paces
  ~1.1s per beat, 28–90ms per char; mostly-CJK text runs ~1.4× slower) — raise
  for a deliberate hero reveal, lower for a fast burst.
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
  to full-view for it). `durationMs` ≈ 900–1400. The next beat's travel will not
  depart until the pan finishes, so a long `durationMs` here shortens the glide
  that follows it — budget the gap accordingly. Use it to reveal sections of a
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
  framed). The camera departs **at the keypress** and rides the reveal in — it
  never pre-zooms into the empty space where a palette/modal is about to appear.
  A bare press (no reveal) holds **full-view** for `durationMs`. As with `scroll`,
  the cursor stays parked for the whole `durationMs` — the reveal plays without a
  pointer crossing it — so the following travel starts only once it is done.
- `settleMs`: hold after the action so its result is visible (~1200–2600ms).
  Give big reveals a longer hold. **It is the EDITORIAL hold only** — you no
  longer have to also guess how long the app takes. If `settleMs` expires while
  the page is still working (network in flight, DOM mutating, a reveal
  animating, a short timer pending), the capture keeps waiting (up to ~1.2s)
  and then TELLS you what the beat actually needed:
  `⏱ step 3: click held 600ms, page needed ~1780ms`. Copy that number into
  `settleMs` and re-`make`. It never shortens a hold, so a snappy app is
  unaffected — but see the canvas caveat under *Capture robustness* below, which
  is the one case where a quiet run proves nothing.
  **Pacing matters for cursor silk:** the cursor
  travels to the next target during the gap BEFORE it, so a tight gap forces a
  fast, snappy move. When you pick a tool then immediately draw (`click` a
  toolbar → `drag` on the canvas), give the click a generous `settleMs`
  (**~1000–1200ms**) so the cursor can glide to the canvas at a calm, constant
  speed instead of darting. Cramped gaps (<800ms) make the travel feel rushed.
  **The CAMERA needs a bigger gap than the cursor.** When a zoomed beat is
  followed by a full-view one (`zoom: "never"`, or a `scroll`), the release
  needs `cursor.pullOutDwellMs + cursor.zoomOutMs` — **~2140ms at the
  defaults** — between the end of the zoomed beat and the next action. Give it
  less and the schedule keeps the full ramp and lands it LATE (fleeing a frame
  the viewer is still reading would be worse), so the camera is still gliding
  when the next click fires. Budget `settleMs ≥ 2200` on any beat whose
  successor releases the zoom — or don't release at all (see HOLD THE FRAME).
- `wait`: paces the video / orients at the start.
- `startCursor`: where the synthetic cursor begins (viewport px); pick a spot
  that makes the first move to your first target a pleasing sweep.

### make (render)
```
npx open-take make --plan plan.json --out demos/myapp.mp4 --draft    # the default loop
npx open-take make --plan plan.json --out demos/myapp.mp4            # master up front
npx open-take make --plan plan.json --out demos/myapp.mp4 --fps 30   # capture at 30
```
Produces `<out>.mp4` (1920×1080 @ **60fps default**) — the one the user posts —
and a working directory `<out>.take/` beside it holding everything else, starting
with the editable `<out>.take/composition.json`.

**Where takes go: `demos/` in the project, never the project root.** All of a
project's takes live in ONE folder so their masters sit side by side — that is
how the user compares them, picks one, and drags it into a post. Do not scatter
takes across the tree and do not drop them in the repo root: `--out` is taken
literally, so where they land is YOUR choice, and two entries per take in
someone's source root is rude. `demos/` is the default (`--out` omitted =
`demos/take.mp4`); follow whatever the project already uses if it has a
convention.

**Name each take after the app or the cut, never `demo.mp4`.** Two demos in one
folder need two names — `demos/myapp.mp4` + `demos/myapp.take/`,
`demos/myapp-pricing.mp4` + `demos/myapp-pricing.take/`. `make` REFUSES to
overwrite a take that was shot from a different app rather than destroying a
capture that cost minutes of real drive time (`--force` overrides — it is the
right flag only when the same app moved address). Re-shooting the SAME app at
the same `--out` is the normal re-make and proceeds, keeping the old master +
composition as `prev.mp4` / `prev.composition.json` (hand-edited zoom overrides
survive a re-plan there — re-apply what still applies).

**Tell the user how to keep it out of git**, once, when you hand over the first
take of a project: `*.take/` in `.gitignore` ignores every take's working files
while leaving the mp4s committable. Never edit their `.gitignore` yourself.

**`--draft` renders the initial mp4 at draft quality** (30fps cap + motion blur
off — several times faster) while the capture still records at the full fps and
the composition in the working dir keeps the full-quality settings; the closing `render`
masters the same take with no re-shoot. Use it by default — the first cut
exists to be verified and refined, not posted. (`--fps 30` is different: it
halves the CAPTURE grid too, capping the master at 30fps.)

**fps (default 60).** Capture is always a pure-CDP screencast (drives AND
records over a self-launched headless Chrome); `--fps` sets both the capture
encode and the render grid. 60 is the premium, cinematic feel — continuous
motion (`drag`/sketch, scroll, video) stays smooth and the ink keeps up with the
cursor. **`--fps 30` halves render time + file size** — use it for fast drafts
while iterating, or for pure click/type demos where the gain is marginal. Needs
a Chrome (auto-downloaded on first run — see Prerequisites).

`make` prints the layout and the exact `render` command to refine:
```
mp4:         demo.mp4                     ← the one to post
working dir: demo.take/                   (everything below lives here)
composition: demo.take/composition.json   ← edit this
capture:     demo.take/capture.mp4        ← render reads this (the frozen recording)
capture log: demo.take/capture.json       ← render auto-loads this (capture-lock ground truth)
dossier:     demo.take/dossier.md         ← the exploration harvest (you write this — see below)
```
Every verb takes the take by ANY member — `demo.mp4`, `demo.take/`, a file
inside it, or a directory holding exactly one take — and resolves the rest. Pass
`demo.mp4`; that is the name a user knows.

After the capture, `make` frame-diffs the recording around every action and
writes what each one actually changed into the log (`effectBox` — the changed
region; `changeCoverage` — how much of the frame it touched). The auto-camera
frames the PAYOFF region rather than just the clicked control (a search's
results, a preview that swaps elsewhere) and pulls out to full view on global
repaints (nav / restyle). Fully automatic; you never write these fields.
**`changeCoverage: 0` (or a missing `effectBox`) does NOT mean the beat did
nothing** — a subtle effect (a 1px outline, a low-opacity highlight) diffs
below the threshold and is often visually fine. The annotation steers the
camera; the frames (step 5) are the ground truth for "did it work".

**After the first successful `make`, write the dossier** — `<base>.take/dossier.md`,
the exploration harvest the NEXT demo of this app reads instead of re-exploring: what the app is + audience · hero candidates you kept
AND rejected (with why) · the verified selector map · content answers (search
terms with hits, seeded data) · hazards (autofocus races, saves that write
files, lazy-load waits). Keep it human-readable — it doubles as your
UNDERSTAND notes — and update it whenever refine or a re-make teaches you
something new about the app.

### refine (re-render edits — no app drive)
```
npx open-take render demo.mp4        # <take> form: the working dir resolves from it
```
Re-renders the **edited** composition over the **kept** capture, keeping the
previous master as `demo.take/prev.mp4` (committed only on success — a refused
render never clobbers the revert point; the editor's Export keeps the same
promise). Auto-loads the
kept capture log (`demo.take/capture.json`) as the capture-lock ground truth
(`--capture-log <path>` overrides it). Validates first and **refuses to render an
errored composition** (prints the field + a suggested fix in milliseconds, before
paying for a render) — e.g. a `zoom.scale` below the rest scale (zooms *out* past
the frame), a `zoom.inAtMs` after its action, or a **drifted action `tMs`** (the
capture-lock). Warnings (a no-op zoom, a soft-cap scale) print but don't block.

**Map the user's words to fields** (edit `demo.take/composition.json`, then `render`):
- *"don't zoom on X" / "too zoomy"* → that beat's `zoom.enabled: false`.
- *"zoom on X" / "tighter on X"* → `zoom.enabled: true` and/or raise `zoom.scale`
  (toward ~2.0; the validator soft-caps ~2.5). If the beat has a `bbox`, set
  `center` to its middle (`{x: bbox.x+bbox.w/2, y: bbox.y+bbox.h/2}`); a bbox-less
  beat (a bare `press`) needs a hand-set `center` in video-px.
- *"hold X longer" / "too quick"* → raise `cursor.holdMs` (global) — the dwell
  after a beat settles before zooming out.
- *"it zooms away while I'm still reading" / "rushed between beats"* →
  `cursor.pullOutDwellMs` (default 800): the minimum stay on a payoff before a
  squeezed pull-out may depart — it then LANDS late (after its own action)
  instead of fleeing the frame. 0 restores the legacy depart-at-action-end.
- *"the zoom stops abruptly" / "the ending clicks off"* → `cursor.zoomSettleFrac`
  (default 0.04): the residual each camera move keeps settling INTO the hold
  (an asymptotic tail instead of a velocity cliff at the keyframe). 0 = the old
  hard-normalized spring cut. Inert while `zoomEase`/`zoomSpring` is set.
- *"cut the dead opening" / "it starts before the app painted"* → `startMs`
  (top-level, ms): head-trims the DELIVERED mp4 on the composition timeline —
  no more `ffmpeg -ss` side-files that desync from the refine loop. Keep it ≤
  the first beat's `zoom.inAtMs` (the validator warns past that).
- *"gentler / faster zoom"* → `cursor.zoomInMs` / `zoomOutMs` (bigger = slower
  ramp; defaults 730/1340 are frame-measured off a reference recorder — pull-outs are
  deliberately ~1.8× slower). Past **2× the slowest pace** (`calm` = 900/1650)
  these warn: a ramp LANDS on its action, so a longer window only moves the
  departure earlier and the camera creeps. The default CURVE is a critically-damped spring
  (the measured premium feel); `cursor.zoomSpring: 0.05–0.3` adds a touch of
  overshoot/snap. A composition carrying the legacy `cursor.zoomEase` (bezier)
  keeps it until you delete the key, set `zoomSpring`, or apply a pace preset —
  prefer removing `zoomEase` so the spring default applies.
- *"start the zoom earlier"* → lower that beat's `zoom.inAtMs` (keep it ≥ 0 and
  ≤ `tMs`; the punch-in default is `tMs − cursor.zoomInMs`). NB a beat that
  PULLS OUT (scroll / wider framing) auto-paces with `zoomOutMs` when its
  `inAtMs` is still the planner default; a hand-edited `inAtMs` always wins.
- *"tighter frame / less border"* → raise `framing.insetFrac` (toward 1.0);
  *"more cinematic backdrop"* → `framing.background.from/to`, `cornerRadius`.
- *"slower / silkier cursor"* → lower `cursor.travelWidthsPerSec` (or raise
  `travelMaxMs`); *"less curve"* → lower `cursor.arcFrac`/`arcMax`. NB the speed
  is measured on the DELIVERED frame, so a zoomed beat's travel is automatically
  stretched by the camera's magnification *averaged over the leg* — never
  hand-compensate for zoom.
  The travel clamps **ride the `pace` preset** (calm 375/1060 · natural 300/850 ·
  brisk 235/660), so re-pacing moves the short hops and long sweeps too, not just
  the legs that happen to fall between the clamps. A HAND-SET clamp still
  overrides the pace on the legs it binds, and `make`/`render` warn when one has
  taken over most of the take.
- *"it parks, then darts"* → that gap is in the CAPTURE, not the composition. A
  travel is `travelDur` long and lands ON the action, so a long `settleMs`
  leaves dead air no cursor knob can fill. Shorten the previous step's
  `settleMs` and re-`make`. Do NOT stretch `travelMinMs`/`zoom.inAtMs` to cover
  it: a punch-in ramp's END is pinned to `tMs`, so "start earlier" IS "go
  slower", and much past `zoomInMs` the settle curve reads as a crawl.
- *"slower intro"* → move `start` farther from the first target (longer opening
  sweep), or add a leading `wait` **and re-`make`** if you need real dead time
  before the first action (dead time is capture, not composition).
- *"trim the end" / "it lingers"* → lower `durationMs` (keep it past the last
  action + `cursor.zoomOutMs`, or the final zoom-out gets cut).
- *"reorder / cut / change what it does / retime a beat"* → **choreography:
  re-`make`** with an edited plan. `render` can't move an action in time (its
  `tMs` is locked to the recording).

### notes (the editor → you channel)
```
npx open-take notes demo.mp4 --wait   # background: blocks, exits on the next note
npx open-take notes demo.mp4          # drain: prints what you have not read yet
```
The editor's Agent panel appends one line per note to `demo.take/notes.md`. `notes`
reads the ones you have not seen and remembers the position in
`demo.take/notes.cursor`, so each note reaches you **exactly once** — `--all`
re-reads the whole log, `--timeout <seconds>` caps a wait (default 1800), and a
burst typed together arrives as one batch. With no `<take>` it resolves the take
in the current directory. Treat its output exactly like a message the user
typed: ECHO each note, resolve, then batch ONE render.

## Capture robustness — checks that keep "user does nothing" honest
- **Read the `⚠ n composition warnings` block.** Every render path (`make`,
  `render`, `--review`, `--draft`) re-prints the validator's non-fatal findings
  in its end-of-run summary, because the copy it writes at the render boundary
  is minutes deep in progress output by the time you see the result. Warnings
  describe things the viewer will notice. Treat them like skipped steps: act, or
  justify out loud.
- **Confirm no beat was dropped.** A missing target is skipped, recorded on the
  capture log (`skipped[]`), and listed in `make`'s end-of-run summary
  (`⚠ n steps skipped`); `--strict` additionally exits non-zero. If a beat was
  dropped, fix the target (re-`inspect`; names/layout may have changed) or just
  re-run (capture can flake on a cold first run) — never ship a silently-empty
  demo. ALWAYS look at the frames (step 5) to catch this.
- **For `drag`, verify the stroke actually rendered.** A drag whose endpoints
  resolved still produces *nothing visible* if the wrong tool was active or the
  surface ignored synthetic input — eyeball the frames mid-stroke. (Select the
  tool with a `click` first; CDP mouse input is trusted, so canvas libs that
  listen for pointer events do respond.)
- **On a canvas app, a quiet capture proves nothing.** The settle check reads the
  page's STRUCTURE — elements appearing, text changing, requests in flight. A
  `<canvas>`/`<video>` never changes structurally no matter what is being drawn
  inside it, so an editor mid-render (Figma/Excalidraw-style tools, games, WebGL
  maps, animated charts, video players) looks perfectly still. Measured: a canvas
  painting for 1.5s reported ZERO beats needing more time. `make` flags it —
  `🎨 a <canvas>/<video> covers ~91% of the frame` — and when you see that line:
  (a) the ABSENCE of `⏱` lines is not evidence your timings were right, (b) budget
  those beats' `settleMs` generously by hand, and (c) prove it with `frames`
  (step 5), which reads real pixels. This is also why `changeCoverage` in the
  frame-diff output is the only automatic check that sees a canvas — and it runs
  AFTER the recording, so it can report a dead beat but never wait for one.
- **App state starts clean each run.** Capture launches Chrome on a fresh temp
  profile (removed on close), so `localStorage`/cookies do NOT leak between runs
  — a stateful app (canvas tool, editor) opens empty every time. If your demo
  *needs* seeded state, set it up within the plan itself (type/click your way
  in), not across runs.
- **Target unlabeled controls by CSS `selector`** (see inspect note). The
  selector path is atomic (resolve-bbox-and-click in one page eval), so it's as
  robust as the text path.
- **A beat that saves/exports can write REAL files into the user's project.**
  The app under demo is the user's actual app — a "save" or "export" beat may
  write into their working tree (measured runs did exactly this, to an
  UNTRACKED file `git status` alone wouldn't flag). Before planning one, find
  out what it writes; prefer a scratch target, or back the file up first and
  restore it after the shoot — leave the user's repo byte-identical to how you
  found it, and say you did.

## Editorial guidance (what makes a good draft)
- Lead with an orienting beat so the viewer sees the app whole; the
  first/orienting beat usually should not zoom.
- Make the app's *signature* moment the hero. If the hero is global (a restyle,
  a navigation), show it full-view — don't zoom into it.
- One strong closer (a result, a completed action, a striking page/state).
- **~25s is a target, not a floor.** A tight, all-signal 12–18s draft beats a
  padded 25s. Snappy beats read better than long holds.
- **Never pad to length with trailing `wait`s.** A long wait after the last
  payoff delivers a frozen screen, not a closer — and it is invisible unless
  you watch the tail (the contact sheet's last row exists for exactly this).
  If a beat has to wait on a slow backend, the wait is *capture* (so the
  recording has real pixels to show), but the delivered length is *composition*:
  trim `durationMs` back to about the last beat's settle. The validator warns
  (`Xs of tail after the last beat settles — the delivered video ends on a
  frozen screen`). If the wait is genuinely long, put a BEAT in it — a camera
  move onto whatever the app is doing meanwhile beats a static hold.
- **A demo that spans two pages is ONE take — use `navigate`.** Same tab, so the
  recording is continuous, the camera is at rest across the seam by
  construction, and you get one `composition.json` to refine instead of two
  plus a concat. Use it whenever the second page is reachable as a URL, even if
  you can't know that URL when you write the plan (`hrefFrom` reads it off the
  page at capture time).
- **Two takes only when one browser genuinely cannot do it.** The real case is
  a change of IDENTITY: take A runs `--profile me` (logged in) and take B must
  be anonymous to prove the thing is publicly live. One take = one browser
  launch = one profile, so that one is a real split. Then: shoot each, join them
  (`ffmpeg concat`), and cut on two FULL-VIEW frames — cutting into a *zoomed*
  frame reads as a glitch, not an edit, because the viewer has no way to tell a
  new scene from a camera jump. Trim the outgoing take to just after its payoff
  settles and let the incoming take open at rest.
- Don't click things that navigate away from the app (external links). If you
  *want* to go somewhere, say so with `navigate` — an accidental jump mid-beat
  leaves the rest of the plan pointing at a page that no longer exists.

## Known limits (don't be surprised; flag when they bite the story)
- **A new tab/window is invisible to the recording.** The screencast is bound to
  ONE page target, so a `target="_blank"` link, a popup, or an OAuth window is
  simply not filmed — the video keeps showing the old page while the action
  happens somewhere you can't see. Don't click those. When the destination is
  what you want, take the same href in the tab you're already recording:
  `{ "action": "navigate", "hrefFrom": { "text": "<the link>" } }`.
- **One take = one browser = one auth profile.** `--profile` is chosen at
  launch, so a demo that must be logged in for one half and anonymous for the
  other is genuinely two takes (see the editorial note above). Everything else
  about "spanning two pages" is `navigate`, not a split.
- **Hover-TRACKING effects aren't capturable.** The synthetic cursor dispatches
  input at each beat's target, not continuously along its travel — an effect
  that FOLLOWS the mouse (an outline tracking the pointer, a magnetic hover, a
  spotlight under the cursor) never fires mid-flight. Hover-DWELL reveals (a
  tooltip/dropdown at a target) work fine. Show a tracking effect as dwells at
  1–2 representative targets and flag the downgrade out loud.
- **Vocabulary edges to flag when they bite the story:** a hover-reveal whose menu
  has no accessible name *and* no stable selector; multi-key sequences within one
  beat (chain separate `press` steps); precise inner-scroller targeting (scroll
  dispatches a wheel at viewport centre, so it pans the main document — a nested
  scroll region not under centre may need a hand-tuned `dy`); text selection isn't
  a first-class verb (`drag` across the text, but it won't always select).
- **fps: 60 by default; `--fps 30` is the fast-draft halving (see make).** Not a
  story limit — 60 is smooth for continuous motion. On a 30fps render, lean drag
  `durationMs` slower (1500–2500ms).
- **Captures run cold-cache.** The fresh temp profile means a fresh HTTP cache:
  webfonts are waited on before recording starts (`document.fonts.ready`,
  bounded), but any OTHER third-party asset — hero images, lazy chunks, CDN
  scripts — loads cold in every take, unlike a returning user's browser. If a
  late asset pops in the frames, self-host it or add a leading `wait`; use
  `startMs` to trim what still slips into the head.
- viewport ≠ video scaling is implemented but lightly tested.

## Prerequisites
- The `open-take` bin resolvable by `npx open-take` — either the npm package
  installed in the project, or (in this monorepo) `pnpm install && pnpm build`
  (the root workspace links the bin, so `npx open-take` works here too).
  **Always run `npx open-take` from that project's directory** — a bare npx
  anywhere else silently resolves the REGISTRY copy, which may be older than
  this document (its CLI errors on flags it doesn't know; if you see that,
  check `npx open-take --version` and your cwd).
- A Chrome to drive: open-take auto-downloads **Chrome-for-Testing** on first
  run (cached under `~/.open-take/browsers`), or set `OPEN_TAKE_CHROME` to a
  Chrome binary. (No agent-browser needed — capture is pure CDP.)
- `ffmpeg`/`ffprobe`: system binaries if present, else the bundled
  `@ffmpeg-installer`/`@ffprobe-installer` platform binaries resolve
  automatically (frame extraction for SHOW still wants a system `ffmpeg`).
