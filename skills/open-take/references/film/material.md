## Material from the real product

The product gives a film several kinds of material, side by side; none is
the default:

- **What it says** — its headline, copy, numbers and pictures, and the pages
  it links to (About, docs, repository): `materials.json`, from
  `film init --url` or any saved screen.
- **What it makes** — the file, picture, page or result it puts out, kept as
  a file of its own with `s.save` in `open-take shoot` and read on the page
  with `(await stills(url, img)).output(name)` (below).
- **Its interface** — from one `make --states` recording, on one clock: the
  **recording** (the real action at its real speed), the **saved screen**
  (sharp at any size, its parts separable) and the **real output** of that
  action. A film can go from one to another — the real action, its result
  lifted out, the result where it is used — as one continuous shot or as
  cuts on the music.

Its parts also come as files: `film init --url`, `shoot` and `make --states`
write each part `components.json` lists as `parts/<state>-<el>-<kind>.html`
(the film's `parts/` beside its `states/`; `<out>/parts/` for a shoot,
`<take>.take/parts/` for a take) — the part's own elements with every
computed style inlined, the page's `@font-face` rules for its fonts and its
images from the saved files, so it opens alone, at any size, in the
product's styles, with no page CSS. Each file's header names its source
URL, state, selector, kind, label and values; `parts/index.json` lists every
file with its ref, kind, label, values, natural size and picture, and each
part that is not a file with the reason (a frame from another site). An
iframe of its size shows one (`transform: scale(k)` for any other size), or
`(await partFiles("parts/")).node(ref)` in kit/media.js puts it into the
page in a shadow root of its own. One more route beside the others; none is
the default.

### One thing of the product's on its own

A button, a number, a card, a tab, a line of its text — shown on its own,
big enough to read, with something happening to it: pressed, typing itself,
a number working out, a page switching, rows arriving. Often a control and
what it changes go together (a tab and the panel it switches). There are
three ways to draw it, side by side; none is the default, a film can use
any of them for any moment, and how good it looks is the film's:

- **In place**, on the real screen — the recording, or a saved screen in an
  iframe: the camera on it (`cam.frame`), the rest faded (`isolate`), what
  is pressed and what it changes both in frame. The viewer sees the real
  page do it.
- **Lifted out** — `lift` makes one part (or several, as one layer) a live
  copy of its own, sitting where it was: it moves anywhere at any size
  (`place`, `group`, `arrange`, `carry`), and inside it the product's own
  elements move (`find`, `parts`, `text` with motion.js's `count` and
  `assemble`). Below, and in `components.json`.
- **Rebuilt** as the film's own HTML, CSS, SVG or canvas, laid out at the
  size it is shown, in the product's fonts and colours (`film look`) — the
  shape is yours, its values can be the product's own (`readValues`,
  below).

How to draw it and where its data comes from are two questions. Drawn any
of the three ways, a number or a string on screen can be one the product
showed (a part's values in `components.json`), one its live page shows (a
URL), one it works out from inputs the film states, or data you made up —
then say so on screen, so a viewer can tell it is a demo. Where the real
data is empty (no listings yet), the film can show that honestly, or show
another feature. `tl.source` records which, and `film probe` sets the
film's numbers beside it (below).

- The product's own assets: a saved screen is a self-contained copy of the
  page with its fonts, colours and images as the page served them, and
  `film look` reads its fonts (the files), colours and type sizes into
  `look.css` (`skill film look`) — use them rather than lookalikes. When
  you can read the product's repository, its source assets are there too —
  with what the live product no longer shows or never did (spare and
  retired pictures, stock photos kept for empty states), which someone who
  knows the product will not take for it. Where a picture is on the live
  site, and where, says which it is.
- `npx open-take shoot shoot.mjs --out shots` runs your own capture script in
  open-take's browser and keeps the log: `s.open(url)` (loaded, hydrated, arrived,
  settled), `s.still(name)`, `s.click` / `s.type(…, { each: true })` /
  `s.drag(…, { every: 4 })` (real input, then a 2× still), `s.track(selector)`,
  `s.save(name, target)` (what the product made, as a file of its own in
  `shots/outputs/`: an `<svg>` with its styles inlined, a `<canvas>`'s PNG, an
  `<img>`'s source, a field's value or a result's text, or a picture of any
  box; `s.save(name, { download: () => s.click("text=Export") })` keeps the
  file the page downloads) — the film reads it with
  `(await stills(url, img)).output(name)`: its URL, kind, size, text and the
  still before it.
  `shots/shots.json` holds every still with the cursor, the scroll and the box
  of everything tracked or acted on — read it, never copy coordinates by hand.
  A still keeps the interface too: each `s.still()` and the still an action
  ends on also writes a saved screen to `shots/states/<id>/state.html` with
  its `index.json` — the same capture and fidelity check as `make --states`
  below; `<id>` is the still's name (`home-2` when a folder of that name is
  already there), and the still's `state` field in `shots.json` names it,
  with `states.items` saying how each re-rendered (`fidelity.ok`). The stills
  on the way (a keystroke's with `each`, a drag step's with `every`) keep
  none; `state: true` or `state: false` on a call says it for every still
  that call takes, and `--states` / `--no-states` (or `runShoot({ states })`)
  for the whole shoot. A screen costs about 0.3–0.5 s; one that cannot be
  read keeps the still without it, with a line saying why. Before each
  still — the stills on the way too — the shoot waits until what is on
  screen stops changing (visible text and where it sits, finite
  animations), up to 3 s (2 s a step), so a product's own count-up or slide
  is shot where it rests; a still taken while it changed anyway carries
  `moving` (its texts `before` → `after`), one it waited for `steadyMs`.
  `steady: false` on a call (or `settle: false`), or `--no-steady`, takes
  stills as they come, in-between values and all; `film probe` lists the
  pictures on screen whose still was taken changing. In the page,
  `stills(log).state("home")` (by index, name or id) is that screen's URL and
  `screen(iframe, url)` shows it, so `lift` and `isolate` take it as they are:

  ```js
  const st = await stills("shots/shots.json", document.querySelector("#still"));
  const home = screen(document.querySelector("#home"), st.state("home"));
  const total = lift(home, "#total", { around: "clear" });
  ```

  `st.changes(key)` (a still's index or name, or a screen's id) is what the
  action before that screen changed there: `parts`, innermost first, each
  with `what` (appeared, changed, moved, restyled), `was` and `now` in full,
  the words it gained (`added`) and lost (`removed`), and its `box` in the
  still's own CSS px; `still` is the still that shows it. A take's
  `changes(state | step)` is the same for a recording.

  `film init --url <url>` keeps one the same way, of the product's page, in
  the film's `states/home/` (once the screen holds still; `--no-steady` at
  once).
  For what the helpers do not cover, `s.cdp` is the page's CDP session,
  `s.wsEndpoint` lets Puppeteer or Playwright connect to the same browser, and
  `s.inject(js)` runs before the page's own scripts. Stills are taken between
  inputs while the product's own clock keeps running: its animations play
  faster across them — record the real thing (`make`) where speed matters.
- `npx open-take make --plan plan.json --out takes/x.mp4 --states --no-render`
  records the real app (no polished master — a film only needs the material)
  and saves the interface itself at every settled moment:
  `takes/x.take/states/s3/state.html` is a self-contained copy of the page as
  it was (scripts inert). Put it in an `<iframe>` and it is the real UI, sharp
  at any scale (to push slowly into it, push a picture of it — moving text in
  `skill film render`); same-origin, so your page can reach into
  `iframe.contentDocument` to hide, restyle or animate single elements — what
  moves inside a frame, your page moves (a frame runs its own timers and
  animation frames only where it is put on the page).
  `npx open-take states takes/x.mp4 --state s3 --json` outlines it — its
  regions and the parts worth naming, each with an id and a box —
  and `states/s3/index.json` beside the saved page lists every element.
  Its summary says how many pictures the page sent while each drag was held
  (and the longest gap): the film can only replay those, so a stroke caught at
  a few a second plays as a few jumps however the cursor is timed. A capture
  falls behind when the machine is busy — another render or capture at the
  same time took one drag from 54 a second to 6.6.
- The recording itself (`takes/x.take/capture.mp4`) plays as a `<video>` on
  film time, frame-exact, and `capture.json` holds every click, keystroke and
  cursor position with its time — and, measured off the recording, when each
  action's result showed and when it stopped changing (`result.atMs`,
  `doneMs`, its box) and when the page went quiet (`settledMs`). A click and
  its result are often not one moment: a result measured 1.5 s after its
  click is not rare, and a film whose cuts follow the click times cuts away
  before the result shows. `open-take states <take> --measure` adds
  these readings to a take recorded before them; `open-take states` prints
  them.

`kit/media.js` joins the three on the film's clock:

```js
import { screen, readTake, clip, clipEvents, seam, lift, isolate } from "./kit/media.js";
import { morphRect, smooth } from "./kit/motion.js";
import { tl } from "./timeline.js";                     // your timeline (kit/time.js)
const s = screen(document.querySelector("#app"));      // states/s3/state.html in an iframe
const c = clip({ at: 0, from: 12.0, to: 16 });          // film 0 s shows the recording's 12.0 s
const card = lift(s, "e126", { around: "clear" });      // the part the app just produced
const rest = isolate(s, ["e126"]);                      // the rest fades into the page
let T = Infinity;
const took = readTake("../takes/x.take/").then((take) => {
  T = clipEvents(take, c, { tl }).find((e) => e.kind === "result" && e.action === "a2").t;
});
window.__film = { duration: 6, ready: Promise.all([took, card.ready, rest.ready]), ...tl.hooks() };
window.__render = (t) => {
  rest.set(smooth((t - T) / 0.4));
  card.place(morphRect(t, T, T + 0.6, card.rect, { x: 0, y: 0, w: 1920, h: 1080, r: 0 }), { fit: "cover" });
};
```

- `screen(iframe, src)` shows a saved screen in an iframe of its viewport's
  size — one already in the iframe's `src`, or `src` (a take's or a shoot's
  `state.html`); `box(selector | id)` is where a part of it is now.
- `readTake(url)` reads a take's `capture.json` (`fromLog(log, base)` for
  one in hand): its actions, its recording, its saved states.
- `clip({ at, from, to, speed })` — or `clip({ keys: [[film, rec], …] })`, a
  clip that slows down round a click and hurries through the waiting — maps
  film time onto the recording: `toCapture(t)`, `toFilm(c)`, `videoTime(t)`.
- `clipEvents(take, clip, { tl, kinds })` turns the actions inside the clip
  into film events — the input, and apart from it `"result"`,
  `"resultDone"` and `"settled"` — each `basis: "measured"` or
  `"estimated"`, a result after the clip's end `"outside the clip"`, none
  found `"not detected"`; with `tl` they are declared for the score too.
- `seam(take, clip, "s3", { video })` says when the saved screen shows the
  same thing as the recording (`window`, in film time) and where to put it
  so it lands on the video (`transform` — for a positioned box at the
  stage's 0, 0 holding its iframe; on the iframe itself `lift`, `isolate`
  and `box` cannot measure through it), with what `make` measured between
  the two (`residual`). Measured on a rendered swap (test/film-seam-e2e):
  nothing moves at the swap frame, and it differs from the frame before by
  no more than `residual`; on macOS the recording's darks show lighter than
  the saved screen's (a dark green 76 → 87 of 255) — the recording is
  tagged with BT.709's curve, which Chrome on macOS shows through Apple's
  gamma. A part lifted inside that box moves with it, so its `rect` and
  `place()` are in the state's px: a stage box `b` is
  `((b.x − offset.x) / scale, (b.y − offset.y) / scale, b.width / scale,
  b.height / scale)` there — full frame is the stage's size only at scale 1
  (checked on a 2× stage: the plain stage box carries the card twice too big).
- `lift(screen, part, { around, into, box, pad, radius, background, css,
  fit, parts })` lifts one real part — a selector, an index id (`"e126"`),
  a ref (`"calc-end:e126"`), `{ text: "會籍手續費", up: 2 }` (found by its
  visible text, then that many ancestors), an element or a box — or a list
  of them as one layer, as a layer of its own, sitting exactly where it was,
  live DOM so it stays sharp at any size. `box`/`rect` are where it sat
  (what `morphRect`, `hop` and the other handoffs start from), `member(i)`
  each listed part's; `place(rect, { opacity, fit })` moves it;
  `restyle(css)` changes only the copy. `around: "clear"` keeps the part
  alone, see-through around it; `box: "ink"` fits the window to its text,
  not its full-width block. Inside it, live: `doc`, `find(key)`, `parts()`
  (its children in order, for `assemble`), `text(s, el?)` (the text it
  shows — the text holding its digits unless `el` names one);
  `view(box | null)` un-crops it into its whole screen; `from(cam, t)` is
  where it shows under a camera. A hidden source: `screen(iframe, src,
  { hidden: true })` — laid out, not seen. A scene hidden by `display:none`
  has no layout to lift from; `scenes()` (kit/time.js) hides by visibility,
  and a lifted part hides with its scene.
- `group(parts)` moves several lifted parts as one body (`place(rect)`);
  `arrange(parts, rect, { axis, gap, align })` returns a slot each, side by
  side at one scale; `carry(A, B, t, a, b, { swapAt })` hands one part over
  to another (the same card in two screens) without a cut.
- `hold(screens, part, { to, axis })` keeps one part in place while saved
  screens are swapped in turn (a card the product pushes down as it adds a
  row): in each screen it moves the part to where it sits in the `to`th,
  the rest of each screen as the product laid it out; `point(i, p)` moves a
  point taken on screen i (a click's cursor) with it; `release()`.
- `isolate(screen, parts, { color, opacity, blur })` fades everything but
  those parts; `set(p)`, 0 to 1.
- `throughCamera(box, cam, t)` is a box under a camera as it shows in the
  picture — to carry a part out of a moving layer, or into `matchCut`;
  `fitTransform(from, to, fit)` the transform from one box onto another.

### One reference for a part

`const P = await product("/shots/", { tl, states })` reads an inventory
(`components.json`, below — a shoot's folder, a take, a film's `states/`, one
saved screen's folder) with its log and screens' `index.json`, so later calls
answer at once. `P.part(key, { name })` is one part followed through every
screen it is on — key: a ref (`"n-1:e88"`), a track (`"t1"`), `{ text, up }`
or a part; no match throws, naming what there is. The camera, the cursor,
`lift`, `isolate`, `hold` and `screen().box` take it as they take a box:
`cam.frame(part, { arrive })` frames where it is when the move lands,
`cur.click(part, t)` lands on the point the capture acted on it, carried to
where it is then, `lift(screen, part)` lifts it from whichever screen that
frame shows.

- `P.play([[t, stateId | { still: i }], …])` (or `t → id`, or a `clip()`) says
  which screen shows when; `P.state(t)` / `P.still(t)` read it back for the
  page's own swapping. Without it each part is read on its own screen.
- `P.view({ place, cam, el })`: where the screens are drawn — a `seam()`
  result, a box, `{ x, y, scale }` or `t →` one — and the camera over them.
- The chain, all of it on `part.at(t)`: `screen` (the screen's CSS px) →
  `stage` (the layer's px: `place`) → `picture` (through `cam`, as
  `throughCamera`), with `inFrame`, `shown` (false: not on the screen shown
  then, read on the nearest one that has it) and `sourcePx` (picture px per
  px of the still or the recording that shows it). `boxAt(t)`, `pointAt(t)`
  are the layer's px; `coveredBy(t)` what the page draws over it;
  `mark(t, label)` names it for the report (a caption, a voice).
- `P.drag(key, at, end, { ease, press })` — key: a track or a shoot's drag
  name (its stills `<name>-<i>`), or a take's action (`"a3"`, with
  `{ clip }`, its own path, times and pace) — is the cursor's path through
  the real point of each saved step, with `steps` (when each step shows: as
  the cursor, paced by `ease`, reaches it), `state(t)`, `value(t)`; a
  track's steps are the screens a drag of the shoot took along it
  (`{ states }` names others). `cur.drag(d)` walks it; `P.play([..., ...d.steps, ...])` swaps in step.
- Every number on it is the film's to change: `ease`, `press`, `end`,
  `steps` (a plain list), `place`; a part is also a box, a point, a ref
  (`part.ref`, `part.in(state)`) for anything that takes those.

### The parts: `components.json`

`shoot` and `make --states` measure each saved screen's parts while they
check it, and write `components.json` beside the log (`shots/`,
`<take>.take/`; `--no-components` skips it); `film init --url` writes one
in `states/home/`. `npx open-take components <dir>` measures screens saved
before that and prints, per screen, its parts by kind and what the action
before it changed; `film init --from <dir>` does the same for the film's
material. It is an index of what there is, in the page's order: nothing in
it says which part a film uses. Version 2 holds, per part (`components[]`):

- `ref` (`<state>:<element id>` — what `lift`, `open-take states --state`
  and `readValues` take), `kind` (number, stat, heading, button, input,
  control, field, badge, media, logo, card, group, text), `label` (≤ 80 characters, for a
  glance), `box`, `ink`, `inside`, `parts`, `members`, `look`;
- `values` — what it holds, by field, in full: `text`, `number`, `label`,
  an input's `value` / `placeholder` / `min` / `max` / `step` / `checked` /
  `options`, `name`;
  each `{ text, value?, unit?, source: { state, eid, selector?, shot? } }`;
- `relations` — `{ kind, to, by }`: `changes` (the action before a screen
  acted on it and `to` changed or appeared there), `controls` (a tab and its
  panel, by `aria-controls`), `labels`, `contains`; `by` is `seen` (the log
  and the screens' diff), `markup` or `layout`;
- `provenance` — `{ state, url, capturedAt, tMs, local }`; `local`: the
  page was on this machine, so its data may be a local seed, not the live
  product's;
- `facts` — `acted`, `changed` ("was → now"), `restyled` (a tab now
  selected, a fill changed), `moved`, `appeared`, with its sizes;
- `fit` (where it would sit fitted to the stage), `phone` (how big its
  text reads on a phone as part of the whole screen and fitted), `picture`
  (a crisp PNG of it alone), `lift` (the options that reproduce it), `track`.

Beside them: `states[]`, each with its `action` (what was done before it,
and in `action.changes` every part that changed or appeared after it, a
part or not); `tracks[]`, one part followed through the screens with what
it read at each step (a total rising as a slider moves); and `skipped[]`
with a reason each. `open-take components <dir> --snippet <ref>` prints a
module that lifts the part you name and moves it on its own values (a
number counts only from a value a screen before it held).

### The whole page: `materials.json`

`components.json` measures what is on screen at a saved moment; the first
screen `shoot` (or `film init --url`) keeps on each page also reads that
whole page, top to bottom, into `states/<id>/materials.json`
(`--no-materials` skips it), and prints a few lines of it.
`npx open-take materials <dir>` prints all of it in page order with where
the first screen ends, and reads a screen saved before this from its
`state.html`. It lists, in page order, and picks nothing:

- `images[]` — `<img>`/`<picture>`, inline `<svg>` drawings, CSS
  background images, `<video>`, `<canvas>`: `kind`, `box` (page px, y from
  the top of the whole page), `alt` / `name`, `src` (the largest source the
  page offers, `srcW` its width), `natural`, `file` (a saved copy in
  `states/assets/`, `fileSize`), or `notSaved` with why; `firstScreen`,
  `in` (nav, header, footer…), `hidden` ("opacity 0" — a reveal not yet
  run, "outside the page width" — a carousel slide), `selector`;
- `copy[]` — headings (`level`), paragraphs, list items, quotes, captions,
  text set larger than the body: `tag`, `text`, `fontPx`, `weight`, `box`,
  `firstScreen`, `in`, `hidden`;
- `meta` (description, og:image and its saved copy), `sheet` (the page as
  one small picture in columns, `columnPx` page px each, from the saved
  screen), `skipped` (counted with a reason), `scope` (what was read).

### Where the values come from

```js
import { readValues } from "./kit/media.js";
const v = await readValues("../shots/components.json", { tl });  // before __film.ready
v.fields("calc-end:e149");                          // a stat: ["text", "number", "label"]
price.textContent = v.text("calc-end:e149", "number");          // "NT$3,376"
const n = v.valueOf("calc-end:e149", "number").value;           // 3376
v.relations("calc:e12");                            // [{ kind: "changes", to: "calc-end:e149", by: "seen" }]
tl.source("six listings", { note: "demo", selector: "#market" });
tl.source("monthly fee", { url: "https://…/brands/world-gym", text: "NT$1,688" });
```

`readValues(url, { tl })` (or `partValues(json, { tl })`) reads a
`components.json`: `refs()`, `part(ref)`, `fields`, `values`, `valueOf`,
`text`, `withField(field)`, `relations`, `provenance`. A field the part did
not show is an error naming the fields it did — it never makes one up. With
`tl`, each value read is declared as its own source. `tl.source(label,
{ ref, field, file, url, note, text, selector })` declares the rest: a part,
a live URL, or a note ("demo", "illustrative"); `label` is what it covers on
screen. Declare before the page is ready — `film render` reads the list
once then, into the events file's `sources`. A count's in-between numbers
are the film's: declare its ends.

`film probe` adds "Where the values on screen come from": each declared
source and when it is on screen, then each number in the film's own text
(not in saved screens or lifted parts — those are the product's page) as
`declared`, `matches a part` or `no source declared`, text that reads
exactly as a part's value, and how many in-between numbers it counted. It
reads the `components.json` files the sources name and those in the page's
folder. Information, not a gate: a value the screens did not keep can
still be real — a formula, the product's code, a live page.
